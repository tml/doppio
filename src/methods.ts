"use strict";
import util = require('./util');
import ByteStream = require('./ByteStream');
import attributes = require('./attributes');
import JVM = require('./jvm');
import java_object = require('./java_object');
import ConstantPool = require('./ConstantPool');
import ClassData = require('./ClassData');
import threading = require('./threading');
import gLong = require('./gLong');
import ClassLoader = require('./ClassLoader');
import assert = require('./assert');

var JavaArray = java_object.JavaArray;
var JavaObject = java_object.JavaObject;



var trapped_methods = {
  'java/lang/ref/Reference': {
    // NOP, because we don't do our own GC and also this starts a thread?!?!?!
    '<clinit>()V': function (thread: threading.JVMThread): void { }
  },
  'java/lang/System': {
    'loadLibrary(Ljava/lang/String;)V': function (thread: threading.JVMThread, lib_name: java_object.JavaObject): void {
      var lib = lib_name.jvm2js_str();
      if (lib !== 'zip' && lib !== 'net' && lib !== 'nio' && lib !== 'awt' && lib !== 'fontmanager') {
        thread.throwNewException('Ljava/lang/UnsatisfiedLinkError;', `no ${lib} in java.library.path`);
      }
    }
  },
  'java/lang/Terminator': {
    'setup()V': function (thread: threading.JVMThread): void {
      // XXX: We should probably fix this; we support threads now.
      // Historically: NOP'd because we didn't support threads.
    }
  },
  'java/util/concurrent/atomic/AtomicInteger': {
    'compareAndSet(II)Z': function (thread: threading.JVMThread, javaThis: java_object.JavaObject, expect: number, update: number): boolean {
      javaThis.set_field(thread, 'Ljava/util/concurrent/atomic/AtomicInteger;value', update);
      // always true, because we only have one thread of execution
      // @todo Fix: Actually check expected value!
      return true;
    }
  },
  'java/nio/Bits': {
    'byteOrder()Ljava/nio/ByteOrder;': function (thread: threading.JVMThread): java_object.JavaObject {
      var cls = <ClassData.ReferenceClassData> thread.getBsCl().getInitializedClass(thread, 'Ljava/nio/ByteOrder;');
      return cls.staticGet(thread, 'LITTLE_ENDIAN');
    },
    'copyToByteArray(JLjava/lang/Object;JJ)V': function (thread: threading.JVMThread, srcAddr: gLong, dst: java_object.JavaArray, dstPos: gLong, length: gLong): void {
      var heap = thread.getThreadPool().getJVM().getHeap(),
        srcStart = srcAddr.toNumber(),
        dstStart: number = dstPos.toNumber(),
        len: number = length.toNumber(),
        i: number,
        arr = dst.array;
      for (i = 0; i < len; i++) {
        arr[dstStart + i] = heap.get_byte(srcStart + i);
      }
    }
  },
  'java/nio/charset/Charset$3': {
    // this is trapped and NOP'ed for speed
    'run()Ljava/lang/Object;': function (thread: threading.JVMThread, javaThis: java_object.JavaObject): java_object.JavaObject {
      return null;
    }
  }
};

function getTrappedMethod(clsName: string, methSig: string): Function {
  clsName = util.descriptor2typestr(clsName);
  if (trapped_methods.hasOwnProperty(clsName) && trapped_methods[clsName].hasOwnProperty(methSig)) {
    return trapped_methods[clsName][methSig];
  }
  return null;
}

export class AbstractMethodField {
  public cls: ClassData.ReferenceClassData;
  public slot: number = -1;
  public accessFlags: util.Flags;
  public name: string;
  public raw_descriptor: string;
  public attrs: attributes.IAttribute[];

  constructor(cls: ClassData.ReferenceClassData) {
    this.cls = cls;
  }

  public parse(bytes_array: ByteStream, constant_pool: ConstantPool.ConstantPool): void {
    this.accessFlags = new util.Flags(bytes_array.getUint16());
    this.name = (<ConstantPool.ConstUTF8> constant_pool.get(bytes_array.getUint16())).value;
    this.raw_descriptor = (<ConstantPool.ConstUTF8> constant_pool.get(bytes_array.getUint16())).value;
    this.parse_descriptor(this.raw_descriptor);
    this.attrs = attributes.makeAttributes(bytes_array, constant_pool);
  }

  /**
   * Sets the field or method's slot. Called once its class is resolved.
   */
  public setSlot(slot: number): void {
    this.slot = slot;
  }

  public get_attribute(name: string): attributes.IAttribute {
    for (var i = 0; i < this.attrs.length; i++) {
      var attr = this.attrs[i];
      if (attr.getName() === name) {
        return attr;
      }
    }
    return null;
  }

  public get_attributes(name: string): attributes.IAttribute[] {
    return this.attrs.filter((attr) => attr.getName() === name);
  }

  // To satiate TypeScript. Consider it an 'abstract' method.
  public parse_descriptor(raw_descriptor: string): void {
    throw new Error("Unimplemented error.");
  }
}

export class Field extends AbstractMethodField {
  public type: string;

  public parse_descriptor(raw_descriptor: string): void {
    this.type = raw_descriptor;
  }

  /**
   * Calls cb with the reflectedField if it succeeds. Calls cb with null if it
   * fails.
   */
  public reflector(thread: threading.JVMThread, cb: (reflectedField: java_object.JavaObject) => void): void {
    var found = <attributes.Signature> this.get_attribute("Signature");
    // note: sig is the generic type parameter (if one exists), not the full
    // field type.
    var sig = (found != null) ? found.sig : null;
    var jvm = thread.getThreadPool().getJVM();
    var bsCl = thread.getBsCl();
    var create_obj = (clazz_obj: java_object.JavaClassObject, type_obj: java_object.JavaObject) => {
      var field_cls = <ClassData.ReferenceClassData> bsCl.getInitializedClass(thread, 'Ljava/lang/reflect/Field;'),
        annotations: attributes.RuntimeVisibleAnnotations = <any> this.get_attribute('RuntimeVisibleAnnotations');
      return new java_object.JavaObject(field_cls, {
        'Ljava/lang/reflect/Field;clazz': clazz_obj,
        'Ljava/lang/reflect/Field;name': jvm.internString(this.name),
        'Ljava/lang/reflect/Field;type': type_obj,
        'Ljava/lang/reflect/Field;modifiers': this.accessFlags.getRawByte(),
        'Ljava/lang/reflect/Field;slot': this.slot,
        'Ljava/lang/reflect/Field;signature': sig != null ? java_object.initString(bsCl, sig) : null,
        'Ljava/lang/reflect/Field;annotations': annotations != null ? (<ClassData.ArrayClassData> thread.getBsCl().getInitializedClass(thread, '[B')).create(annotations.rawBytes) : null
      });
    };
    var clazz_obj = this.cls.getClassObject(thread);
    // type_obj may not be loaded, so we asynchronously load it here.
    // In the future, we can speed up reflection by having a synchronous_reflector
    // method that we can try first, and which may fail.
    this.cls.getLoader().resolveClass(thread, this.type, (cdata: ClassData.ClassData) => {
      if (cdata != null) {
        var type_obj = cdata.getClassObject(thread),
          rv = create_obj(clazz_obj, type_obj);
        cb(rv);
      } else {
        cb(null);
      }
    });
  }
}

export class Method extends AbstractMethodField {
  public param_types: string[];
  private param_bytes: number;
  private num_args: number;
  public return_type: string;
  // Code is either a function, or a CodeAttribute. We should have a factory method
  // that constructs NativeMethod objects and BytecodeMethod objects.
  private code: any;

  public parse_descriptor(raw_descriptor: string): void {
    var match = /\(([^)]*)\)(.*)/.exec(raw_descriptor);
    var param_str = match[1];
    var return_str = match[2];
    var param_carr = param_str.split('');
    this.param_types = [];
    var field: string;
    while (field = util.carr2descriptor(param_carr)) {
      this.param_types.push(field);
    }
    this.param_bytes = 0;
    for (var i = 0; i < this.param_types.length; i++) {
      var p = this.param_types[i];
      this.param_bytes += (p === 'D' || p === 'J') ? 2 : 1;
    }
    if (!this.accessFlags.isStatic()) {
      this.param_bytes++;
    }
    this.num_args = this.param_types.length;
    if (!this.accessFlags.isStatic()) {
      // nonstatic methods get 'this'
      this.num_args++;
    }
    this.return_type = return_str;
  }

  public isHidden(): boolean {
    var rva: attributes.RuntimeVisibleAnnotations = <any> this.get_attribute('RuntimeVisibleAnnotations');
    return rva !== null && rva.isHidden;
  }

  public full_signature(): string {
    return util.ext_classname(this.cls.getInternalName()) + "::" + this.name + this.raw_descriptor;
  }

  /**
   * Get the number of machine words (32-bit words) required to store the
   * parameters to this function. Includes adding in a machine word for 'this'
   * for non-static functions.
   */
  public getParamWordSize(): number {
    return this.param_bytes;
  }

  /**
   * Get the number of parameters required for this function. Distinct from
   * `getParamWordSize()`, since in this function, 64-bit values are counted
   * once.
   */
  public getNumberOfParameters(): number {
    return this.num_args;
  }

  public getCodeAttribute(): attributes.Code {
    assert(!this.accessFlags.isNative() && !this.accessFlags.isAbstract());
    return this.code;
  }

  public getNativeFunction(): Function {
    assert(this.accessFlags.isNative() && typeof (this.code) === 'function');
    return this.code;
  }

  public parse(bytes_array: ByteStream, constant_pool: ConstantPool.ConstantPool): void {
    super.parse(bytes_array, constant_pool);
    var sig = this.full_signature(),
      clsName = this.cls.getInternalName(),
      methSig = this.name + this.raw_descriptor;

    if (getTrappedMethod(clsName, methSig) != null) {
      this.code = getTrappedMethod(clsName, methSig);
      this.accessFlags.setNative(true);
    } else if (this.accessFlags.isNative()) {
      if (sig.indexOf('::registerNatives()V', 1) < 0 && sig.indexOf('::initIDs()V', 1) < 0) {
        this.code = (thread: threading.JVMThread) => {
          // Try to fetch the native method.
          var jvm = thread.getThreadPool().getJVM(),
            c = jvm.getNative(clsName, methSig);
          if (c == null) {
            thread.throwNewException('Ljava/lang/UnsatisfiedLinkError;', `Native method '${sig}' not implemented.\nPlease fix or file a bug at https://github.com/plasma-umass/doppio/issues`);
          } else {
            this.code = c;
            return c.apply(this, arguments);
          }
        };
      } else {
        // NOP.
        this.code = () => { };
      }
    } else if (!this.accessFlags.isAbstract()) {
      this.code = this.get_attribute('Code');
    }
  }

  public reflector(thread: threading.JVMThread, is_constructor: boolean, cb: (reflectedMethod: java_object.JavaObject) => void): void {
    if (is_constructor == null) {
      is_constructor = false;
    }

    var typestr = is_constructor ? 'Ljava/lang/reflect/Constructor;' : 'Ljava/lang/reflect/Method;',
      exceptionAttr = <attributes.Exceptions> this.get_attribute("Exceptions"),
      annAttr = <attributes.RuntimeVisibleAnnotations> this.get_attribute("RuntimeVisibleAnnotations"),
      annDefaultAttr = <attributes.AnnotationDefault> this.get_attribute("AnnotationDefault"),
      sigAttr = <attributes.Signature> this.get_attribute("Signature"),
      obj = {},
      clazz_obj = this.cls.getClassObject(thread),
      toResolve: string[] = [],
      bsCl: ClassLoader.BootstrapClassLoader = thread.getBsCl(),
      jvm = thread.getThreadPool().getJVM(),
      loader = this.cls.getLoader(),
      hasCode = (!this.accessFlags.isNative() && !this.accessFlags.isAbstract()),
      parameterAnnotations = <attributes.RuntimeVisibleParameterAnnotations> this.get_attribute('RuntimeVisibleParameterAnnotations');

    // Resolve the return type.
    toResolve.push(this.return_type);
    // Resolve exception handler types.
    var code: attributes.Code = this.code;
    if (hasCode && code.exceptionHandlers.length > 0) {
      toResolve.push('Ljava/lang/Throwable;');  // Mimic native java.
      var eh = code.exceptionHandlers;
      for (var i = 0; i < eh.length; i++) {
        if (eh[i].catchType !== '<any>') {
          toResolve.push(eh[i].catchType);
        }
      }
    }
    // Resolve parameter types.
    toResolve.push.apply(toResolve, this.param_types);
    // Resolve checked exception types.
    if (exceptionAttr != null) {
      toResolve.push.apply(toResolve, exceptionAttr.exceptions);
    }

    loader.resolveClasses(thread, toResolve, (classes) => {
      if (classes === null) {
        // FAILED. An exception has been thrown.
        cb(null);
      } else {
        var jco_arr_cls = <ClassData.ArrayClassData> bsCl.getInitializedClass(thread, '[Ljava/lang/Class;');
        var byte_arr_cls = <ClassData.ArrayClassData> bsCl.getInitializedClass(thread, '[B');
        var cls = <ClassData.ReferenceClassData> bsCl.getInitializedClass(thread, typestr);
        var param_type_objs: java_object.JavaClassObject[] = [];
        var i: number;
        for (i = 0; i < this.param_types.length; i++) {
          param_type_objs.push(classes[this.param_types[i]].getClassObject(thread));
        }
        var etype_objs: java_object.JavaClassObject[] = [];
        if (exceptionAttr != null) {
          for (i = 0; i < exceptionAttr.exceptions.length; i++) {
            etype_objs.push(classes[<string> exceptionAttr.exceptions[i]].getClassObject(thread));
          }
        }
        obj[typestr + 'clazz'] = clazz_obj;
        obj[typestr + 'name'] = jvm.internString(this.name);
        obj[typestr + 'parameterTypes'] = new JavaArray(jco_arr_cls, param_type_objs);
        obj[typestr + 'returnType'] = classes[this.return_type].getClassObject(thread);
        obj[typestr + 'exceptionTypes'] = new JavaArray(jco_arr_cls, etype_objs);
        obj[typestr + 'modifiers'] = this.accessFlags.getRawByte();
        obj[typestr + 'slot'] = this.slot;
        obj[typestr + 'signature'] = sigAttr != null ? jvm.internString(sigAttr.sig) : null;
        obj[typestr + 'annotations'] = annAttr != null ? new JavaArray(byte_arr_cls, annAttr.rawBytes) : null;
        obj[typestr + 'annotationDefault'] = annDefaultAttr != null ? new JavaArray(byte_arr_cls, annDefaultAttr.rawBytes) : null;
        obj[typestr + 'parameterAnnotations'] = parameterAnnotations != null ? new JavaArray(byte_arr_cls, parameterAnnotations.rawBytes) : null;
        cb(new JavaObject(cls, obj));
      }
    });
  }

  /**
   * Convert the arguments to this method into a form suitable for a native
   * implementation.
   *
   * The JVM uses two parameter slots for double and long values, since they
   * consist of two JVM machine words (32-bits). Doppio stores the entire value
   * in one slot, and stores a NULL in the second.
   *
   * This function strips out these NULLs so the arguments are in a more
   * consistent form. The return value is the arguments to this function without
   * these NULL values. It also adds the 'thread' object to the start of the
   * arguments array.
   */
  public convertArgs(thread: threading.JVMThread, params: any[]): any[] {
    if (this.isSignaturePolymorphic()) {
      // These don't need any conversion, and have arbitrary arguments.
      // Just append the thread object.
      params.unshift(thread);
      return params;
    }
    var convertedArgs = [thread], argIdx = 0, i: number;
    if (!this.accessFlags.isStatic()) {
      convertedArgs.push(params[0]);
      argIdx = 1;
    }
    for (i = 0; i < this.param_types.length; i++) {
      var p = this.param_types[i];
      convertedArgs.push(params[argIdx]);
      argIdx += (p === 'J' || p === 'D') ? 2 : 1;
    }
    return convertedArgs;
  }

  /**
   * Takes the arguments to this function from the top of the input stack,
   * and returns them as a new array.
   */
  public takeArgs(caller_stack: any[]): any[] {
    var start = caller_stack.length - this.param_bytes;
    var params = caller_stack.slice(start);
    // this is faster than splice()
    caller_stack.length -= this.param_bytes;
    return params;
  }

  public method_lock(thread: threading.JVMThread, frame: threading.BytecodeStackFrame): java_object.Monitor {
    if (this.accessFlags.isStatic()) {
      // Static methods lock the class.
      return this.cls.getClassObject(thread).getMonitor();
    } else {
      // Non-static methods lock the instance.
      return (<java_object.JavaObject> frame.locals[0]).getMonitor();
    }
  }

  /**
   * Check if this is a signature polymorphic method.
   * From S2.9:
   * A method is signature polymorphic if and only if all of the following conditions hold :
   * * It is declared in the java.lang.invoke.MethodHandle class.
   * * It has a single formal parameter of type Object[].
   * * It has a return type of Object.
   * * It has the ACC_VARARGS and ACC_NATIVE flags set.
   */
  public isSignaturePolymorphic(): boolean {
    return this.cls.getInternalName() === 'Ljava/lang/invoke/MethodHandle;' &&
      this.accessFlags.isNative() && this.accessFlags.isVarArgs() &&
      this.raw_descriptor === '([Ljava/lang/Object;)Ljava/lang/Object;';
  }
}
