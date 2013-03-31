
# pull in external modules
util = require './util'
fs = node?.fs ? require 'fs'
path = node?.path ? require 'path'
{trace,error} = require '../src/logging'
"use strict"

# things assigned to root will be available outside this module
root = exports ? this.jvm = {}

root.classpath = []
root.show_NYI_natives = false
root.dump_state = false

root.read_classfile = (cls, cb, failure_cb) ->
  cls = cls[1...-1] # Convert Lfoo/bar/Baz; -> foo/bar/Baz.
  for p in root.classpath
    filename = "#{p}/#{cls}.class"
    try
      continue unless fs.existsSync filename
      data = util.bytestr_to_array fs.readFileSync(filename, 'binary')
      cb(data) if data?
      return
    catch e
      failure_cb(()->throw e) # Signifies an error occurred.
      return

  failure_cb (()->throw new Error "Error: No file found for class #{cls}.")

# Sets the classpath to the given value in typical classpath form:
# path1:path2:... etc.
# jcl_path is the location of the Java Class Libraries. It is the only path
# that is implicitly the last item on the classpath.
# Standardizes the paths for JVM usage.
# XXX: Should make this asynchronous at some point for checking the existance
#      of classpaths.
root.set_classpath = (jcl_path, classpath) ->
  classpath = classpath.split(':')
  classpath.push jcl_path
  @classpath = []
  # All paths must:
  # * Exist.
  # * Be a the fully-qualified path.
  # * Have a trailing /.
  for class_path, i in classpath
    class_path = path.normalize class_path
    if class_path.charAt(class_path.length-1) != '/'
      class_path += '/'
    # XXX: Make this asynchronous sometime.
    if fs.existsSync(class_path)
      @classpath.push(class_path)
  return

# main function that gets called from the frontend
root.run_class = (rs, class_name, cmdline_args, done_cb) ->
  class_descriptor = "L#{class_name};"
  main_spec = class: class_descriptor, sig: 'main([Ljava/lang/String;)V'
  main_method = null
  run_main = ->
    trace "run_main"
    rs.run_until_finished (->
      rs.async_op (resume_cb, except_cb) ->
        rs.get_bs_cl().initialize_class rs, class_descriptor, ((cls)->
          rs.init_args cmdline_args
          # wrap it in run_until_finished to handle any exceptions correctly
          rs.run_until_finished (-> main_method = cls.method_lookup rs, main_spec), true, (success) ->
            return done_cb?() unless success and main_method?
            rs.run_until_finished (-> main_method.setup_stack(rs)), false, (success) ->
              done_cb?() if success
        ), except_cb
    ), true, (->)

  run_program = ->
    trace "run_program"
    rs.run_until_finished (-> rs.init_threads()), true, (success) ->
      return unless success
      if rs.system_initialized?
        run_main()
      else
        rs.run_until_finished (-> rs.init_system_class()), true, (success) ->
          return unless success
          run_main()

  rs.run_until_finished (->
    rs.async_op (resume_cb, except_cb) ->
      rs.preinitialize_core_classes run_program, ((e)->
        # Error during preinitialization? Abort abort abort!
        throw e
      )
  ), true, (->)
