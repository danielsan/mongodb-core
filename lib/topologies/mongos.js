"use strict"

var inherits = require('util').inherits,
  f = require('util').format,
  EventEmitter = require('events').EventEmitter,
  BSON = require('bson').native().BSON,
  ReadPreference = require('./read_preference'),
  BasicCursor = require('../cursor'),
  Logger = require('../connection/logger'),
  debugOptions = require('../connection/utils').debugOptions,
  MongoError = require('../error'),
  Server = require('./server'),
  ReplSetState = require('./replset_state'),
  assign = require('./shared').assign;

/**
 * @fileOverview The **Mongos** class is a class that represents a Mongos Proxy topology and is
 * used to construct connections.
 *
 * @example
 * var Mongos = require('mongodb-core').Mongos
 *   , ReadPreference = require('mongodb-core').ReadPreference
 *   , assert = require('assert');
 *
 * var server = new Mongos([{host: 'localhost', port: 30000}]);
 * // Wait for the connection event
 * server.on('connect', function(server) {
 *   server.destroy();
 * });
 *
 * // Start connecting
 * server.connect();
 */

var MongoCR = require('../auth/mongocr')
  , X509 = require('../auth/x509')
  , Plain = require('../auth/plain')
  , GSSAPI = require('../auth/gssapi')
  , SSPI = require('../auth/sspi')
  , ScramSHA1 = require('../auth/scram');

//
// States
var DISCONNECTED = 'disconnected';
var CONNECTING = 'connecting';
var CONNECTED = 'connected';
var DESTROYED = 'destroyed';

function stateTransition(self, newState) {
  var legalTransitions = {
    'disconnected': [CONNECTING, DESTROYED, DISCONNECTED],
    'connecting': [CONNECTING, DESTROYED, CONNECTED, DISCONNECTED],
    'connected': [CONNECTED, DISCONNECTED, DESTROYED],
    'destroyed': [DESTROYED]
  }

  // Get current state
  var legalStates = legalTransitions[self.state];
  if(legalStates && legalStates.indexOf(newState) != -1) {
    self.state = newState;
  } else {
    self.logger.error(f('Pool with id [%s] failed attempted illegal state transition from [%s] to [%s] only following state allowed [%s]'
      , self.id, self.state, newState, legalStates));
  }
}

//
// ReplSet instance id
var id = 1;
var handlers = ['connect', 'close', 'error', 'timeout', 'parseError'];

/**
 * Creates a new Mongos instance
 * @class
 * @param {array} seedlist A list of seeds for the replicaset
 * @param {number} [options.haInterval=5000] The High availability period for replicaset inquiry
 * @param {Cursor} [options.cursorFactory=Cursor] The cursor factory class used for all query cursors
 * @param {number} [options.size=5] Server connection pool size
 * @param {boolean} [options.keepAlive=true] TCP Connection keep alive enabled
 * @param {number} [options.keepAliveInitialDelay=0] Initial delay before TCP keep alive enabled
 * @param {number} [options.localThresholdMS=15] Cutoff latency point in MS for MongoS proxy selection
 * @param {boolean} [options.noDelay=true] TCP Connection no delay
 * @param {number} [options.connectionTimeout=1000] TCP Connection timeout setting
 * @param {number} [options.socketTimeout=0] TCP Socket timeout setting
 * @param {boolean} [options.singleBufferSerializtion=true] Serialize into single buffer, trade of peak memory for serialization speed
 * @param {boolean} [options.ssl=false] Use SSL for connection
 * @param {boolean|function} [options.checkServerIdentity=true] Ensure we check server identify during SSL, set to false to disable checking. Only works for Node 0.12.x or higher. You can pass in a boolean or your own checkServerIdentity override function.
 * @param {Buffer} [options.ca] SSL Certificate store binary buffer
 * @param {Buffer} [options.cert] SSL Certificate binary buffer
 * @param {Buffer} [options.key] SSL Key file binary buffer
 * @param {string} [options.passphrase] SSL Certificate pass phrase
 * @param {boolean} [options.rejectUnauthorized=true] Reject unauthorized server certificates
 * @param {boolean} [options.promoteLongs=true] Convert Long values from the db into Numbers if they fit into 53 bits
 * @return {Mongos} A cursor instance
 * @fires Mongos#connect
 * @fires Mongos#reconnect
 * @fires Mongos#joined
 * @fires Mongos#left
 * @fires Mongos#failed
 * @fires Mongos#fullsetup
 * @fires Mongos#all
 * @fires Mongos#serverHeartbeatStarted
 * @fires Mongos#serverHeartbeatSucceeded
 * @fires Mongos#serverHeartbeatFailed
 * @fires Mongos#topologyOpening
 * @fires Mongos#topologyClosed
 * @fires Mongos#topologyDescriptionChanged
 */
var Mongos = function(seedlist, options) {
  var self = this;
  options = options || {};

  // Get replSet Id
  this.id = id++;

  // Internal state
  this.s = {
    options: assign({}, options),
    // BSON instance
    bson: options.bson || new BSON(),
    // Factory overrides
    Cursor: options.cursorFactory || BasicCursor,
    // Logger instance
    logger: Logger('Mongos', options),
    // Seedlist
    seedlist: seedlist,
    // Ha interval
    haInterval: options.haInterval ? options.haInterval : 10000,
    // Disconnect handler
    disconnectHandler: options.disconnectHandler,
    // Server selection index
    index: 0,
    // Connect function options passed in
    connectOptions: {},
    // Are we running in debug mode
    debug: typeof options.debug == 'boolean' ? options.debug : false,
    // localThresholdMS
    localThresholdMS: options.localThresholdMS || 15,
  }

  // Log info warning if the socketTimeout < haInterval as it will cause
  // a lot of recycled connections to happen.
  if(this.s.logger.isWarn()
    && this.s.options.socketTimeout != 0
    && this.s.options.socketTimeout < this.s.haInterval) {
      this.s.logger.warn(f('warning socketTimeout %s is less than haInterval %s. This might cause unnecessary server reconnections due to socket timeouts'
        , this.s.options.socketTimeout, this.s.haInterval));
  }

  // All the authProviders
  this.authProviders = options.authProviders || {
      'mongocr': new MongoCR(this.s.bson), 'x509': new X509(this.s.bson)
    , 'plain': new Plain(this.s.bson), 'gssapi': new GSSAPI(this.s.bson)
    , 'sspi': new SSPI(this.s.bson), 'scram-sha-1': new ScramSHA1(this.s.bson)
  }

  // Disconnected state
  this.state = DISCONNECTED;

  // Current proxies we are connecting to
  this.connectingProxies = [];
  // Currently connected proxies
  this.connectedProxies = [];
  // Disconnected proxies
  this.disconnectedProxies = [];
  // Are we authenticating
  this.authenticating = false;
  // Index of proxy to run operations against
  this.index = 0;
  // High availability timeout id
  this.haTimeoutId = null;
  // Last ismaster
  this.ismaster = null;
  // Lower bound latency
  this.lowerBoundLatency = Number.MAX_VALUE;

  // Add event listener
  EventEmitter.call(this);
}

inherits(Mongos, EventEmitter);

Object.defineProperty(Mongos.prototype, 'type', {
  enumerable:true, get: function() { return 'mongos'; }
});

/**
 * Emit event if it exists
 * @method
 */
function emitSDAMEvent(self, event, description) {
  if(self.listeners(event).length > 0) {
    self.emit(event, description);
  }
}

/**
 * Initiate server connect
 * @method
 * @param {array} [options.auth=null] Array of auth options to apply on connect
 */
Mongos.prototype.connect = function(options) {
  var self = this;
  // Add any connect level options to the internal state
  this.s.connectOptions = options || {};
  // Set connecting state
  stateTransition(this, CONNECTING);
  // Create server instances
  var servers = this.s.seedlist.map(function(x) {
    return new Server(assign({}, self.s.options, x, {
      authProviders: self.authProviders, reconnect:false, monitoring:false, inTopology: true
    }));
  });

  // Emit the topology opening event
  emitSDAMEvent(this, 'topologyOpening', { topologyId: this.id });

  // Start all server connections
  connectProxies(self, servers);
}

function handleEvent(self, event) {
  return function(err) {
    if(self.state == DESTROYED) return;
    // Move to list of disconnectedProxies
    moveServerFrom(self.connectedProxies, self.disconnectedProxies, this);
    // Emit the left signal
    self.emit('left', 'mongos', this);
  }
}

function handleInitialConnectEvent(self, event) {
  return function(err) {
    // Destroy the instance
    if(self.state == DESTROYED) {
      return this.destroy();
    }

    // Check the type of server
    if(event == 'connect') {
      // Get last known ismaster
      self.ismaster = this.lastIsMaster();

      // Add to the connectd list
      for(var i = 0; i < self.connectedProxies.length; i++) {
        if(self.connectedProxies[i].name == this.name) {
          this.destroy();
          return self.emit('failed', this);
        }
      }

      // Remove the handlers
      for(var i = 0; i < handlers.length; i++) {
        this.removeAllListeners(handlers[i]);
      }

      // Add stable state handlers
      this.on('error', handleEvent(self, 'error'));
      this.on('close', handleEvent(self, 'close'));
      this.on('timeout', handleEvent(self, 'timeout'));
      this.on('parseError', handleEvent(self, 'parseError'));

      // Move from connecting proxies connected
      moveServerFrom(self.connectingProxies, self.connectedProxies, this);
      // Emit the joined event
      self.emit('joined', 'mongos', this);
    } else {
      moveServerFrom(self.connectingProxies, self.disconnectedProxies, this);
      // Emit the left event
      self.emit('left', 'mongos', this);
      // Emit failed event
      self.emit('failed', this);
    }

    // Trigger topologyMonitor
    if(self.connectingProxies.length == 0) {
      // Emit connected if we are connected
      if(self.connectedProxies.length > 0) {
        // Set initial lowerBoundLatency
        for(var i = 0; i < self.connectedProxies.length; i++) {
          // Adjust lower bound
          if(self.lowerBoundLatency > self.connectedProxies[i].lastIsMasterMS) {
            self.lowerBoundLatency = self.connectedProxies[i].lastIsMasterMS;
          }
        }

        // Set the state to connected
        stateTransition(self, CONNECTED);
        // Emit the connect event
        self.emit('connect', self);
        self.emit('fullsetup', self);
        self.emit('all', self);
      }

      // Topology monitor
      topologyMonitor(self, {firstConnect:true});
    }
  };
}

function connectProxies(self, servers) {
  // Update connectingProxies
  self.connectingProxies = self.connectingProxies.concat(servers);

  // Index used to interleaf the server connects, avoiding
  // runtime issues on io constrained vm's
  var timeoutInterval = 0;

  function connect(server, timeoutInterval) {
    setTimeout(function() {
      // Add event handlers
      server.once('close', handleInitialConnectEvent(self, 'close'));
      server.once('timeout', handleInitialConnectEvent(self, 'timeout'));
      server.once('parseError', handleInitialConnectEvent(self, 'parseError'));
      server.once('error', handleInitialConnectEvent(self, 'error'));
      server.once('connect', handleInitialConnectEvent(self, 'connect'));
      // SDAM Monitoring events
      server.on('serverOpening', function(e) { self.emit('serverOpening', e); });
      server.on('serverDescriptionChanged', function(e) { self.emit('serverDescriptionChanged', e); });
      server.on('serverClosed', function(e) { self.emit('serverClosed', e); });
      // Start connection
      server.connect(self.s.connectOptions);
    }, timeoutInterval);
  }
  // Start all the servers
  while(servers.length > 0) {
    connect(servers.shift(), timeoutInterval++);
  }
}

function pickProxy(self) {
  // Get the currently connected Proxies
  var connectedProxies = self.connectedProxies.slice(0);

  // Filter out the possible servers
  connectedProxies = connectedProxies.filter(function(server) {
    if((server.lastIsMasterMS <= (self.lowerBoundLatency + self.s.localThresholdMS))
      && server.isConnected()) {
      return true;
    }
  });

  // We have no connectedProxies pick first of the connected ones
  if(connectedProxies.length == 0) {
    return self.connectedProxies[0];
  }

  // Get proxy
  var proxy = connectedProxies[self.index % connectedProxies.length];
  // Update the index
  self.index = (self.index + 1) % connectedProxies.length;
  // Return the proxy
  return proxy;
}

function moveServerFrom(from, to, proxy) {
  for(var i = 0; i < from.length; i++) {
    if(from[i].name == proxy.name) {
      from.splice(i, 1);
    }
  }

  for(var i = 0; i < to.length; i++) {
    if(to[i].name == proxy.name) {
      to.splice(i, 1);
    }
  }

  to.push(proxy);
}

function reconnectProxies(self, proxies, callback) {
  // Count lefts
  var count = proxies.length;

  // Handle events
  var _handleEvent = function(self, event) {
    return function(err, r) {
      var _self = this;
      count = count - 1;

      // Destroyed
      if(self.state == DESTROYED) {
        return this.destroy();
      }

      if(event == 'connect' && !self.authenticating) {
        // Destroyed
        if(self.state == DESTROYED) {
          return _self.destroy();
        }

        // Remove the handlers
        for(var i = 0; i < handlers.length; i++) {
          _self.removeAllListeners(handlers[i]);
        }

        // Add stable state handlers
        _self.on('error', handleEvent(self, 'error'));
        _self.on('close', handleEvent(self, 'close'));
        _self.on('timeout', handleEvent(self, 'timeout'));
        _self.on('parseError', handleEvent(self, 'parseError'));

        // Move to the connected servers
        moveServerFrom(self.disconnectedProxies, self.connectedProxies, _self);
        // Emit joined event
        self.emit('joined', 'mongos', _self);
      } else if(event == 'connect' && self.authenticating) {
        this.destroy();
      }

      // Are we done finish up callback
      if(count == 0) {
        callback();
      }
    }
  }

  // No new servers
  if(count == 0) {
    return callback();
  }

  // Execute method
  function execute(_server, i) {
    setTimeout(function() {
      // Destroyed
      if(self.state == DESTROYED) {
        return;
      }

      // Create a new server instance
      var server = new Server(assign({}, self.s.options, {
        host: _server.name.split(':')[0],
        port: parseInt(_server.name.split(':')[1], 10)
      }, {
        authProviders: self.authProviders, reconnect:false, monitoring: false, inTopology: true
      }));

      // Add temp handlers
      server.once('connect', _handleEvent(self, 'connect'));
      server.once('close', _handleEvent(self, 'close'));
      server.once('timeout', _handleEvent(self, 'timeout'));
      server.once('error', _handleEvent(self, 'error'));
      server.once('parseError', _handleEvent(self, 'parseError'));

      // SDAM Monitoring events
      server.on('serverOpening', function(e) { self.emit('serverOpening', e); });
      server.on('serverDescriptionChanged', function(e) { self.emit('serverDescriptionChanged', e); });
      server.on('serverClosed', function(e) { self.emit('serverClosed', e); });
      server.connect(self.s.connectOptions);
    }, i);
  }

  // Create new instances
  for(var i = 0; i < proxies.length; i++) {
    execute(proxies[i], i);
  }
}

function topologyMonitor(self, options) {
  options = options || {};

  // Set momitoring timeout
  self.haTimeoutId = setTimeout(function() {
    if(self.state == DESTROYED) return;
    // If we have a primary and a disconnect handler, execute
    // buffered operations
    if(self.isConnected() && self.s.disconnectHandler) {
      self.s.disconnectHandler.execute();
    }

    // Get the connectingServers
    var proxies = self.connectedProxies.slice(0);
    // Get the count
    var count = proxies.length;

    // If the count is zero schedule a new fast
    function pingServer(_self, _server, cb) {
      // Measure running time
      var start = new Date().getTime();

      // Emit the server heartbeat start
      emitSDAMEvent(self, 'serverHeartbeatStarted', { connectionId: _server.name });

      // Execute ismaster
      _server.command('admin.$cmd', {ismaster:true}, {monitoring: true}, function(err, r) {
        if(self.state == DESTROYED) {
          _server.destroy();
          return cb(err, r);
        }

        // Calculate latency
        var latencyMS = new Date().getTime() - start;

        // Adjust lower bound
        if(self.lowerBoundLatency > _server.lastIsMasterMS) {
          self.lowerBoundLatency = _server.lastIsMasterMS;
        }

        // We had an error, remove it from the state
        if(err) {
          // Emit the server heartbeat failure
          emitSDAMEvent(self, 'serverHearbeatFailed', { durationMS: latencyMS, failure: err, connectionId: _server.name });
          // Move from connected proxies to disconnected proxies
          moveServerFrom(self.connectedProxies, self.disconnectedProxies, _server);
          // Emit left event
          self.emit('left', 'mongos', _server);
          _server.destroy();
        } else {
          // Update the server ismaster
          _server.ismaster = r.result;
          _server.lastIsMasterMS = latencyMS;

          // Server heart beat event
          emitSDAMEvent(self, 'serverHeartbeatSucceeded', { durationMS: latencyMS, reply: r.result, connectionId: _server.name });
        }

        cb(err, r);
      });
    }

    // No proxies initiate monitor again
    if(proxies.length == 0) {
      // Emit close event if any listeners registered
      if(self.listeners("close").length > 0) {
        self.emit('close', self);
      }

      // Attempt to connect to any unknown servers
      return reconnectProxies(self, self.disconnectedProxies, function(err, cb) {
        if(self.state == DESTROYED) return;

        // Are we connected ? emit connect event
        if(self.state == CONNECTING && options.firstConnect) {
          self.emit('connect', self);
          self.emit('fullsetup', self);
          self.emit('all', self);
        } else if(self.isConnected()) {
          self.emit('reconnect', self);
        } else if(!self.isConnected() && self.listeners("close").length > 0) {
          self.emit('close', self);
        }

        // Perform topology monitor
        topologyMonitor(self);
      });
    }

    // Ping all servers
    for(var i = 0; i < proxies.length; i++) {
      pingServer(self, proxies[i], function(err, r) {
        count = count - 1;

        if(count == 0) {
          if(self.state == DESTROYED) return;

          // Attempt to connect to any unknown servers
          reconnectProxies(self, self.disconnectedProxies, function(err, cb) {
            if(self.state == DESTROYED) return;
            // Perform topology monitor
            topologyMonitor(self);
          });
        }
      });
    }
  }, self.s.haInterval);
}

/**
 * Returns the last known ismaster document for this server
 * @method
 * @return {object}
 */
Mongos.prototype.lastIsMaster = function() {
  return this.ismaster;
}

/**
 * Unref all connections belong to this server
 * @method
 */
Mongos.prototype.unref = function(emitClose) {
  // Transition state
  stateTransition(this, DISCONNECTED);
  // Get all proxies
  var proxies = self.connectedProxies.concat(self.connectingProxies);
  proxies.forEach(function(x) {
    x.unref();
  });

  clearTimeout(this.haTimeoutId);
}

/**
 * Destroy the server connection
 * @method
 */
Mongos.prototype.destroy = function(emitClose) {
  // Transition state
  stateTransition(this, DESTROYED);
  // Get all proxies
  var proxies = this.connectedProxies.concat(this.connectingProxies);
  // Clear out any monitoring process
  if(this.haTimeoutId) clearTimeout(this.haTimeoutId);
  // Destroy all connecting servers
  proxies.forEach(function(x) {
    x.destroy();
  });

  // Emit toplogy closing event
  emitSDAMEvent(this, 'topologyClosed', { topologyId: this.id });

}

/**
 * Figure out if the server is connected
 * @method
 * @return {boolean}
 */
Mongos.prototype.isConnected = function(options) {
  return this.connectedProxies.length > 0;
}

/**
 * Figure out if the server instance was destroyed by calling destroy
 * @method
 * @return {boolean}
 */
Mongos.prototype.isDestroyed = function() {
  return this.state == DESTROYED;
}

//
// Operations
//

// Execute write operation
var executeWriteOperation = function(self, op, ns, ops, options, callback) {
  if(typeof options == 'function') callback = options, options = {}, options = options || {};
  // Ensure we have no options
  options = options || {};
  // Pick a server
  var server = pickProxy(self);
  // No server found error out
  if(!server) return callback(new MongoError('no mongos proxy available'));
  // Execute the command
  server[op](ns, ops, options, callback);
}

/**
 * Insert one or more documents
 * @method
 * @param {string} ns The MongoDB fully qualified namespace (ex: db1.collection1)
 * @param {array} ops An array of documents to insert
 * @param {boolean} [options.ordered=true] Execute in order or out of order
 * @param {object} [options.writeConcern={}] Write concern for the operation
 * @param {Boolean} [options.serializeFunctions=false] Specify if functions on an object should be serialized.
 * @param {Boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {opResultCallback} callback A callback function
 */
Mongos.prototype.insert = function(ns, ops, options, callback) {
  if(typeof options == 'function') callback = options, options = {}, options = options || {};
  if(this.state == DESTROYED) return callback(new MongoError(f('topology was destroyed')));

  // Not connected but we have a disconnecthandler
  if(!this.isConnected() && this.s.disconnectHandler != null) {
    return this.s.disconnectHandler.add('insert', ns, ops, options, callback);
  }

  // No mongos proxy available
  if(!this.isConnected()) {
    return callback(new MongoError('no mongos proxy available'));
  }

  // Execute write operation
  executeWriteOperation(this, 'insert', ns, ops, options, callback);
}

/**
 * Perform one or more update operations
 * @method
 * @param {string} ns The MongoDB fully qualified namespace (ex: db1.collection1)
 * @param {array} ops An array of updates
 * @param {boolean} [options.ordered=true] Execute in order or out of order
 * @param {object} [options.writeConcern={}] Write concern for the operation
 * @param {Boolean} [options.serializeFunctions=false] Specify if functions on an object should be serialized.
 * @param {Boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {opResultCallback} callback A callback function
 */
Mongos.prototype.update = function(ns, ops, options, callback) {
  if(typeof options == 'function') callback = options, options = {}, options = options || {};
  if(this.state == DESTROYED) return callback(new MongoError(f('topology was destroyed')));

  // Not connected but we have a disconnecthandler
  if(!this.isConnected() && this.s.disconnectHandler != null) {
    return this.s.disconnectHandler.add('insert', ns, ops, options, callback);
  }

  // No mongos proxy available
  if(!this.isConnected()) {
    return callback(new MongoError('no mongos proxy available'));
  }

  // Execute write operation
  executeWriteOperation(this, 'update', ns, ops, options, callback);
}

/**
 * Perform one or more remove operations
 * @method
 * @param {string} ns The MongoDB fully qualified namespace (ex: db1.collection1)
 * @param {array} ops An array of removes
 * @param {boolean} [options.ordered=true] Execute in order or out of order
 * @param {object} [options.writeConcern={}] Write concern for the operation
 * @param {Boolean} [options.serializeFunctions=false] Specify if functions on an object should be serialized.
 * @param {Boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {opResultCallback} callback A callback function
 */
Mongos.prototype.remove = function(ns, ops, options, callback) {
  if(typeof options == 'function') callback = options, options = {}, options = options || {};
  if(this.state == DESTROYED) return callback(new MongoError(f('topology was destroyed')));

  // Not connected but we have a disconnecthandler
  if(!this.isConnected() && this.s.disconnectHandler != null) {
    return this.s.disconnectHandler.add('insert', ns, ops, options, callback);
  }

  // No mongos proxy available
  if(!this.isConnected()) {
    return callback(new MongoError('no mongos proxy available'));
  }

  // Execute write operation
  executeWriteOperation(this, 'remove', ns, ops, options, callback);
}

/**
 * Execute a command
 * @method
 * @param {string} ns The MongoDB fully qualified namespace (ex: db1.collection1)
 * @param {object} cmd The command hash
 * @param {ReadPreference} [options.readPreference] Specify read preference if command supports it
 * @param {Connection} [options.connection] Specify connection object to execute command against
 * @param {Boolean} [options.serializeFunctions=false] Specify if functions on an object should be serialized.
 * @param {Boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {opResultCallback} callback A callback function
 */
Mongos.prototype.command = function(ns, cmd, options, callback) {
  if(typeof options == 'function') callback = options, options = {}, options = options || {};
  if(this.state == DESTROYED) return callback(new MongoError(f('topology was destroyed')));
  var self = this;

  // Establish readPreference
  var readPreference = options.readPreference ? options.readPreference : ReadPreference.primary;

  // Pick a proxy
  var server = pickProxy(self);

  // No server returned we had an error
  if(server == null) {
    return callback(new MongoError('no mongos proxy available'));
  }

  // Topology is not connected, save the call in the provided store to be
  // Executed at some point when the handler deems it's reconnected
  if((server == null || !server.isConnected()) && this.s.disconnectHandler != null) {
    return this.s.disconnectHandler.add('command', ns, cmd, options, callback);
  }

  // Execute the command
  server.command(ns, cmd, options, callback);
}

/**
 * Perform one or more remove operations
 * @method
 * @param {string} ns The MongoDB fully qualified namespace (ex: db1.collection1)
 * @param {{object}|{Long}} cmd Can be either a command returning a cursor or a cursorId
 * @param {object} [options.batchSize=0] Batchsize for the operation
 * @param {array} [options.documents=[]] Initial documents list for cursor
 * @param {ReadPreference} [options.readPreference] Specify read preference if command supports it
 * @param {Boolean} [options.serializeFunctions=false] Specify if functions on an object should be serialized.
 * @param {Boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {opResultCallback} callback A callback function
 */
Mongos.prototype.cursor = function(ns, cmd, cursorOptions) {
  cursorOptions = cursorOptions || {};
  var FinalCursor = cursorOptions.cursorFactory || this.s.Cursor;
  return new FinalCursor(this.s.bson, ns, cmd, cursorOptions, this, this.s.options);
}

/**
 * Authenticate using a specified mechanism
 * @method
 * @param {string} mechanism The Auth mechanism we are invoking
 * @param {string} db The db we are invoking the mechanism against
 * @param {...object} param Parameters for the specific mechanism
 * @param {authResultCallback} callback A callback function
 */
Mongos.prototype.auth = function(mechanism, db) {
  var allArgs = Array.prototype.slice.call(arguments, 0).slice(0);
  var self = this;
  var args = Array.prototype.slice.call(arguments, 2);
  var callback = args.pop();

  // If we don't have the mechanism fail
  if(this.authProviders[mechanism] == null && mechanism != 'default') {
    return callback(new MongoError(f("auth provider %s does not exist", mechanism)));
  }

  // Are we already authenticating, throw
  if(this.authenticating) {
    return callback(new MongoError('authentication or logout allready in process'));
  }

  // Topology is not connected, save the call in the provided store to be
  // Executed at some point when the handler deems it's reconnected
  if(!self.isConnected() && self.s.disconnectHandler != null) {
    return self.s.disconnectHandler.add('auth', db, allArgs, {}, callback);
  }

  // Set to authenticating
  this.authenticating = true;
  // All errors
  var errors = [];

  // Get all the servers
  var servers = this.connectedProxies.slice(0);
  // No servers return
  if(servers.length == 0) {
    this.authenticating = false;
    callback(null, true);
  }

  // Authenticate
  function auth(server) {
    // Arguments without a callback
    var argsWithoutCallback = [mechanism, db].concat(args.slice(0));
    // Create arguments
    var finalArguments = argsWithoutCallback.concat([function(err, r) {
      count = count - 1;
      // Save all the errors
      if(err) errors.push({name: server.name, err: err});
      // We are done
      if(count == 0) {
        // Auth is done
        self.authenticating = false;

        // Return the auth error
        if(errors.length) return callback(MongoError.create({
          message: 'authentication fail', errors: errors
        }), false);

        // Successfully authenticated session
        callback(null, self);
      }
    }]);

    // Execute the auth only against non arbiter servers
    if(!server.lastIsMaster().arbiterOnly) {
      server.auth.apply(server, finalArguments);
    }
  }

  // Get total count
  var count = servers.length;
  // Authenticate against all servers
  while(servers.length > 0) {
    auth(servers.shift());
  }
}

/**
 * Logout from a database
 * @method
 * @param {string} db The db we are logging out from
 * @param {authResultCallback} callback A callback function
 */
Mongos.prototype.logout = function(dbName, callback) {
  var self = this;
  // Are we authenticating or logging out, throw
  if(this.authenticating) {
    throw new MongoError('authentication or logout allready in process');
  }

  // Ensure no new members are processed while logging out
  this.authenticating = true;

  // Remove from all auth providers (avoid any reaplication of the auth details)
  var providers = Object.keys(this.authProviders);
  for(var i = 0; i < providers.length; i++) {
    this.authProviders[providers[i]].logout(dbName);
  }

  // Now logout all the servers
  var servers = this.connectedProxies.slice(0);
  var count = servers.length;
  if(count == 0) return callback();
  var errors = [];

  // Execute logout on all server instances
  for(var i = 0; i < servers.length; i++) {
    servers[i].logout(dbName, function(err) {
      count = count - 1;
      if(err) errors.push({name: server.name, err: err});

      if(count == 0) {
        // Do not block new operations
        self.authenticating = false;
        // If we have one or more errors
        if(errors.length) return callback(MongoError.create({
          message: f('logout failed against db %s', dbName), errors: errors
        }), false);

        // No errors
        callback();
      }
    });
  }
}

/**
 * Get server
 * @method
 * @param {ReadPreference} [options.readPreference] Specify read preference if command supports it
 * @return {Server}
 */
Mongos.prototype.getServer = function() {
  var server = pickProxy(this);
  if(this.s.debug) this.emit('pickedServer', null, server);
  return server;
}

/**
 * All raw connections
 * @method
 * @return {Connection[]}
 */
Mongos.prototype.connections = function() {
  var connections = [];

  for(var i = 0; i < this.connectedProxies.length; i++) {
    connections = connections.concat(this.connectedProxies[i].connections());
  }

  return connections;
}

/**
 * A mongos connect event, used to verify that the connection is up and running
 *
 * @event Mongos#connect
 * @type {Mongos}
 */

/**
 * A mongos reconnect event, used to verify that the mongos topology has reconnected
 *
 * @event Mongos#reconnect
 * @type {Mongos}
 */

/**
 * A mongos fullsetup event, used to signal that all topology members have been contacted.
 *
 * @event Mongos#fullsetup
 * @type {Mongos}
 */

/**
 * A mongos all event, used to signal that all topology members have been contacted.
 *
 * @event Mongos#all
 * @type {Mongos}
 */

/**
 * A server member left the mongos list
 *
 * @event Mongos#left
 * @type {Mongos}
 * @param {string} type The type of member that left (mongos)
 * @param {Server} server The server object that left
 */

/**
 * A server member joined the mongos list
 *
 * @event Mongos#joined
 * @type {Mongos}
 * @param {string} type The type of member that left (mongos)
 * @param {Server} server The server object that joined
 */

/**
 * A server opening SDAM monitoring event
 *
 * @event Mongos#serverOpening
 * @type {object}
 */

/**
 * A server closed SDAM monitoring event
 *
 * @event Mongos#serverClosed
 * @type {object}
 */

/**
 * A server description SDAM change monitoring event
 *
 * @event Mongos#serverDescriptionChanged
 * @type {object}
 */

/**
 * A topology open SDAM event
 *
 * @event Mongos#topologyOpening
 * @type {object}
 */

/**
 * A topology closed SDAM event
 *
 * @event Mongos#topologyClosed
 * @type {object}
 */

/**
 * A topology structure SDAM change event
 *
 * @event Mongos#topologyDescriptionChanged
 * @type {object}
 */

/**
 * A topology serverHeartbeatStarted SDAM event
 *
 * @event Mongos#serverHeartbeatStarted
 * @type {object}
 */

/**
 * A topology serverHearbeatFailed SDAM event
 *
 * @event Mongos#serverHearbeatFailed
 * @type {object}
 */

/**
 * A topology serverHeartbeatSucceeded SDAM change event
 *
 * @event Mongos#serverHeartbeatSucceeded
 * @type {object}
 */

module.exports = Mongos;
