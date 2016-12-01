crypto = require 'crypto'
path = require 'path'

_ = require 'underscore-plus'
{Emitter, Disposable} = require 'event-kit'
fs = require 'fs-plus'
Grim = require 'grim'

runas = null # Defer until used
iconv = null # Defer until used

Directory = null
PathWatcher = require './main'

# Extended: Represents an individual file that can be watched, read from, and
# written to.
module.exports =
class File
  encoding: 'utf8'
  realPath: null
  subscriptionCount: 0

  ###
  Section: Construction
  ###

  # Public: Configures a new File instance, no files are accessed.
  #
  # * `filePath` A {String} containing the absolute path to the file
  # * `symlink` A {Boolean} indicating if the path is a symlink (default: false).
  constructor: (filePath, @symlink=false, includeDeprecatedAPIs=Grim.includeDeprecatedAPIs) ->
    filePath = path.normalize(filePath) if filePath
    @path = filePath
    @emitter = new Emitter

    if includeDeprecatedAPIs
      @on 'contents-changed-subscription-will-be-added', @willAddSubscription
      @on 'moved-subscription-will-be-added', @willAddSubscription
      @on 'removed-subscription-will-be-added', @willAddSubscription
      @on 'contents-changed-subscription-removed', @didRemoveSubscription
      @on 'moved-subscription-removed', @didRemoveSubscription
      @on 'removed-subscription-removed', @didRemoveSubscription

    @cachedContents = null
    @reportOnDeprecations = true

  # Public: Creates the file on disk that corresponds to `::getPath()` if no
  # such file already exists.
  #
  # Returns a {Promise} that resolves once the file is created on disk. It
  # resolves to a boolean value that is true if the file was created or false if
  # it already existed.
  create: ->
    @exists().then (isExistingFile) =>
      unless isExistingFile
        parent = @getParent()
        parent.create().then =>
          @write('').then -> true
      else
        false

  ###
  Section: Event Subscription
  ###

  # Public: Invoke the given callback when the file's contents change.
  #
  # * `callback` {Function} to be called when the file's contents change.
  #
  # Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChange: (callback) ->
    @willAddSubscription()
    @trackUnsubscription(@emitter.on('did-change', callback))

  # Public: Invoke the given callback when the file's path changes.
  #
  # * `callback` {Function} to be called when the file's path changes.
  #
  # Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidRename: (callback) ->
    @willAddSubscription()
    @trackUnsubscription(@emitter.on('did-rename', callback))

  # Public: Invoke the given callback when the file is deleted.
  #
  # * `callback` {Function} to be called when the file is deleted.
  #
  # Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidDelete: (callback) ->
    @willAddSubscription()
    @trackUnsubscription(@emitter.on('did-delete', callback))

  # Public: Invoke the given callback when there is an error with the watch.
  # When your callback has been invoked, the file will have unsubscribed from
  # the file watches.
  #
  # * `callback` {Function} callback
  #   * `errorObject` {Object}
  #     * `error` {Object} the error object
  #     * `handle` {Function} call this to indicate you have handled the error.
  #       The error will not be thrown if this function is called.
  onWillThrowWatchError: (callback) ->
    @emitter.on('will-throw-watch-error', callback)

  willAddSubscription: =>
    @subscriptionCount++
    try
      @subscribeToNativeChangeEvents()

  didRemoveSubscription: =>
    @subscriptionCount--
    @unsubscribeFromNativeChangeEvents() if @subscriptionCount is 0

  trackUnsubscription: (subscription) ->
    new Disposable =>
      subscription.dispose()
      @didRemoveSubscription()

  ###
  Section: File Metadata
  ###

  # Public: Returns a {Boolean}, always true.
  isFile: -> true

  # Public: Returns a {Boolean}, always false.
  isDirectory: -> false

  # Public: Returns a {Boolean} indicating whether or not this is a symbolic link
  isSymbolicLink: ->
    @symlink

  # Public: Returns a promise that resolves to a {Boolean}, true if the file
  # exists, false otherwise.
  exists: ->
    new Promise (resolve) =>
      fs.exists @getPath(), resolve

  # Public: Returns a {Boolean}, true if the file exists, false otherwise.
  existsSync: ->
    fs.existsSync(@getPath())

  # Public: Get the SHA-1 digest of this file
  #
  # Returns a promise that resolves to a {String}.
  getDigest: ->
    if @digest?
      Promise.resolve(@digest)
    else
      @read().then => @digest # read assigns digest as a side-effect

  # Public: Get the SHA-1 digest of this file
  #
  # Returns a {String}.
  getDigestSync: ->
    @readSync() unless @digest
    @digest

  setDigest: (contents) ->
    @digest = crypto.createHash('sha1').update(contents ? '').digest('hex')

  # Public: Sets the file's character set encoding name.
  #
  # * `encoding` The {String} encoding to use (default: 'utf8')
  setEncoding: (encoding='utf8') ->
    # Throws if encoding doesn't exist. Better to throw an exception early
    # instead of waiting until the file is saved.

    if encoding isnt 'utf8'
      iconv ?= require 'iconv-lite'
      iconv.getCodec(encoding)

    @encoding = encoding

  # Public: Returns the {String} encoding name for this file (default: 'utf8').
  getEncoding: -> @encoding

  ###
  Section: Managing Paths
  ###

  # Public: Returns the {String} path for the file.
  getPath: -> @path

  # Sets the path for the file.
  setPath: (@path) ->
    @realPath = null

  # Public: Returns this file's completely resolved {String} path.
  getRealPathSync: ->
    unless @realPath?
      try
        @realPath = fs.realpathSync(@path)
      catch error
        @realPath = @path
    @realPath

  # Public: Returns a promise that resolves to the file's completely resolved {String} path.
  getRealPath: ->
    if @realPath?
      Promise.resolve(@realPath)
    else
      new Promise (resolve, reject) =>
        fs.realpath @path, (err, result) =>
          if err?
            reject(err)
          else
            resolve(@realPath = result)

  # Public: Return the {String} filename without any directory information.
  getBaseName: ->
    path.basename(@path)

  ###
  Section: Traversing
  ###

  # Public: Return the {Directory} that contains this file.
  getParent: ->
    Directory ?= require './directory'
    new Directory(path.dirname @path)

  ###
  Section: Reading and Writing
  ###

  readSync: (flushCache) ->
    if not @existsSync()
      @cachedContents = null
    else if not @cachedContents? or flushCache
      encoding = @getEncoding()
      if encoding is 'utf8'
        @cachedContents = fs.readFileSync(@getPath(), encoding)
      else
        iconv ?= require 'iconv-lite'
        @cachedContents = iconv.decode(fs.readFileSync(@getPath()), encoding)

    @setDigest(@cachedContents)
    @cachedContents

  writeFileSync: (filePath, contents) ->
    encoding = @getEncoding()
    if encoding is 'utf8'
      fs.writeFileSync(filePath, contents, {encoding})
    else
      iconv ?= require 'iconv-lite'
      fs.writeFileSync(filePath, iconv.encode(contents, encoding))

  # Public: Reads the contents of the file.
  #
  # * `flushCache` A {Boolean} indicating whether to require a direct read or if
  #   a cached copy is acceptable.
  #
  # Returns a promise that resolves to a String.
  read: (flushCache) ->
    if @cachedContents? and not flushCache
      promise = Promise.resolve(@cachedContents)
    else
      promise = new Promise (resolve, reject) =>
        content = []
        readStream = @createReadStream()

        readStream.on 'data', (chunk) ->
          content.push(chunk)

        readStream.on 'end', ->
          resolve(content.join(''))

        readStream.on 'error', (error) ->
          if error.code == 'ENOENT'
            resolve(null)
          else
            reject(error)

    promise.then (contents) =>
      @setDigest(contents)
      @cachedContents = contents

  # Public: Returns a stream to read the content of the file.
  #
  # Returns a {ReadStream} object.
  createReadStream: ->
    encoding = @getEncoding()
    if encoding is 'utf8'
      fs.createReadStream(@getPath(), {encoding})
    else
      iconv ?= require 'iconv-lite'
      fs.createReadStream(@getPath()).pipe(iconv.decodeStream(encoding))

  # Public: Overwrites the file with the given text.
  #
  # * `text` The {String} text to write to the underlying file.
  #
  # Returns a {Promise} that resolves when the file has been written.
  write: (text) ->
    @exists().then (previouslyExisted) =>
      @writeFile(@getPath(), text).then =>
        @cachedContents = text
        @setDigest(text)
        @subscribeToNativeChangeEvents() if not previouslyExisted and @hasSubscriptions()
        undefined

  # Public: Returns a stream to write content to the file.
  #
  # Returns a {WriteStream} object.
  createWriteStream: ->
    encoding = @getEncoding()
    if encoding is 'utf8'
      fs.createWriteStream(@getPath(), {encoding})
    else
      iconv ?= require 'iconv-lite'
      stream = iconv.encodeStream(encoding)
      stream.pipe(fs.createWriteStream(@getPath()))
      stream

  # Public: Overwrites the file with the given text.
  #
  # * `text` The {String} text to write to the underlying file.
  #
  # Returns undefined.
  writeSync: (text) ->
    previouslyExisted = @existsSync()
    @writeFileWithPrivilegeEscalationSync(@getPath(), text)
    @cachedContents = text
    @setDigest(text)
    @subscribeToNativeChangeEvents() if not previouslyExisted and @hasSubscriptions()
    undefined

  safeWriteSync: (text) ->
    try
      fd = fs.openSync(@getPath(), 'w')
      fs.writeSync(fd, text)

      # Ensure file contents are really on disk before proceeding
      fs.fdatasyncSync(fd)
      fs.closeSync(fd)

      # Ensure file directory entry is really on disk before proceeding
      #
      # Windows doesn't support syncing on directories so we'll just have to live
      # with less safety on that platform.
      unless process.platform is 'win32'
        try
          directoryFD = fs.openSync(path.dirname(@getPath()), 'r')
          fs.fdatasyncSync(directoryFD)
          fs.closeSync(directoryFD)
        catch error
          console.warn("Non-fatal error syncing parent directory of #{@getPath()}")
      return
    catch error
      if error.code is 'EACCES' and process.platform is 'darwin'
        runas ?= require 'runas'
        # Use dd to read from stdin and write to the file path.
        unless runas('/bin/dd', ["of=#{@getPath()}"], stdin: text, admin: true) is 0
          throw error
        # Use sync to force completion of pending disk writes.
        if runas('/bin/sync', [], admin: true) isnt 0
          throw error
      else
        throw error

  writeFile: (filePath, contents) ->
    encoding = @getEncoding()
    if encoding is 'utf8'
      new Promise (resolve, reject) ->
        fs.writeFile filePath, contents, {encoding}, (err, result) ->
          if err?
            reject(err)
          else
            resolve(result)
    else
      iconv ?= require 'iconv-lite'
      new Promise (resolve, reject) ->
        fs.writeFile filePath, iconv.encode(contents, encoding), (err, result) ->
          if err?
            reject(err)
          else
            resolve(result)

  # Writes the text to specified path.
  #
  # Privilege escalation would be asked when current user doesn't have
  # permission to the path.
  writeFileWithPrivilegeEscalationSync: (filePath, text) ->
    try
      @writeFileSync(filePath, text)
    catch error
      if error.code is 'EACCES' and process.platform is 'darwin'
        runas ?= require 'runas'
        # Use dd to read from stdin and write to the file path, same thing could
        # be done with tee but it would also copy the file to stdout.
        unless runas('/bin/dd', ["of=#{filePath}"], stdin: text, admin: true) is 0
          throw error
      else
        throw error

  safeRemoveSync: ->
    try
      # Ensure new file contents are really on disk before proceeding
      fd = fs.openSync(@getPath(), 'a')
      fs.fdatasyncSync(fd)
      fs.closeSync(fd)

      fs.removeSync(@getPath())
      return
    catch error
      if error.code is 'EACCES' and process.platform is 'darwin'
        runas ?= require 'runas'
        # Use sync to force completion of pending disk writes.
        if runas('/bin/sync', [], admin: true) isnt 0
          throw error
        if runas('/bin/rm', ['-f', @getPath()], admin: true) isnt 0
          throw error
      else
        throw error

  ###
  Section: Private
  ###

  handleNativeChangeEvent: (eventType, eventPath) ->
    switch eventType
      when 'delete'
        @unsubscribeFromNativeChangeEvents()
        @detectResurrectionAfterDelay()
      when 'rename'
        @setPath(eventPath)
        @emit 'moved' if Grim.includeDeprecatedAPIs
        @emitter.emit 'did-rename'
      when 'change', 'resurrect'
        oldContents = @cachedContents
        handleReadError = (error) =>
          # We cant read the file, so we GTFO on the watch
          @unsubscribeFromNativeChangeEvents()

          handled = false
          handle = -> handled = true
          error.eventType = eventType
          @emitter.emit('will-throw-watch-error', {error, handle})
          unless handled
            newError = new Error("Cannot read file after file `#{eventType}` event: #{@path}")
            newError.originalError = error
            newError.code = "ENOENT"
            newError.path
            # I want to throw the error here, but it stops the event loop or
            # something. No longer do interval or timeout methods get run!
            # throw newError
            console.error newError

        try
          handleResolve = (newContents) =>
            unless oldContents is newContents
              @emit 'contents-changed' if Grim.includeDeprecatedAPIs
              @emitter.emit 'did-change'

          @read(true).then(handleResolve, handleReadError)
        catch error
          handleReadError(error)

  detectResurrectionAfterDelay: ->
    _.delay (=> @detectResurrection()), 50

  detectResurrection: ->
    @exists().then (exists) =>
      if exists
        @subscribeToNativeChangeEvents()
        @handleNativeChangeEvent('resurrect', @getPath())
      else
        @cachedContents = null
        @emit 'removed' if Grim.includeDeprecatedAPIs
        @emitter.emit 'did-delete'

  subscribeToNativeChangeEvents: ->
    @watchSubscription ?= PathWatcher.watch @path, (args...) =>
      @handleNativeChangeEvent(args...)

  unsubscribeFromNativeChangeEvents: ->
    if @watchSubscription?
      @watchSubscription.close()
      @watchSubscription = null

if Grim.includeDeprecatedAPIs
  EmitterMixin = require('emissary').Emitter
  EmitterMixin.includeInto(File)

  File::on = (eventName) ->
    switch eventName
      when 'contents-changed'
        Grim.deprecate("Use File::onDidChange instead")
      when 'moved'
        Grim.deprecate("Use File::onDidRename instead")
      when 'removed'
        Grim.deprecate("Use File::onDidDelete instead")
      else
        if @reportOnDeprecations
          Grim.deprecate("Subscribing via ::on is deprecated. Use documented event subscription methods instead.")

    EmitterMixin::on.apply(this, arguments)
else
  File::hasSubscriptions = ->
    @subscriptionCount > 0
