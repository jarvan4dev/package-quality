'use strict';

/**
 * Global config settings.
 * (C) 2015 Diego Lafuente.
 */

 // requires
var Log = require('log');

// globals
exports.logLevel = 'info';
var log = new Log(exports.logLevel);

exports.limit = 100;
exports.expressPort = 8080;
exports.packagesCollection = 'packages';
exports.pendingCollection = 'pending';
exports.mongoConnection = 'mongodb://localhost/quality?autoReconnect=true&connectTimeoutMS=5000';
exports.testMongoConnection = 'mongodb://localhost/qualitytest?autoReconnect=true&connectTimeoutMS=5000';
exports.githubToken = '';
exports.githubTokenUpdate = '';
exports.githubApiMaxCallsReachedError = 'MAX_GITHUB_API_CALLS_REACHED';
exports.packageExpiration = 3600;

try {
    var localConfig = require('./local-config.js');
    for (var key in localConfig) {
        exports[key] = localConfig[key];
    }
} catch(exception) {
    log.notice('local-config.js not found');
}