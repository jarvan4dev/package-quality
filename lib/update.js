#!/usr/bin/env node
'use strict';

/**
 * Update only expired packages (those with nextUpdate previous to current date)
 * (C) 2015 Diego Lafuente.
 */

// requires
require('prototypes');
var config = require('../config.js');
var packages = require('../lib/packages.js');
var estimator = require('../lib/estimation.js');
var async = require('async');
var moment = require('moment');
var Log = require('log');
var testing = require('testing');

// globals
var log = new Log(config.logLevel);
var limit = config.limit;

/**
 * Go over all the packages in all.json and update mongo if required.
 * There are two constraints:
 *   - Github only allows 5000 requests per hour.
 *   - We should use config.limit to avoid RangeErrors in the stack size
 * @param all[required]: the object including the packages to update, preserving the all.json format.
 * @param callback[required]: a function(error, result) with the results of the process
 */
exports.goOver = function(all, callback)
{
	var names = Object.keys(all);
	var numberOfPackages = names.length;
	limit = (limit === null) || (numberOfPackages < limit) ? numberOfPackages : limit;
	var chunks = [];
	for (var j = 0; j < Math.ceil(numberOfPackages/limit); j++)
	{
		chunks.push([]);
	}
	var packageCount = 0;
	for (var name in all)
	{
		var entry = all[name];
		var index = Math.floor(packageCount/limit);
		chunks[index].push(getEstimator(entry));
		packageCount++;
		delete all[name];
	}
	log.debug('number of chunks: ' + chunks.length);
	var series = [];
	while (chunks.length)
	{
		series.push(getChunkProcessor(chunks.shift()));
	}
	log.debug('series has length ' + series.length);
	async.series(series, function(error)
	{
		if (error)
		{
			callback(error);
		}
		callback(null, series.length);
	});
};

function getEstimator(entry)
{
	return function(callback)
	{
		var name = entry.name;
		var now = moment();
		packages.find(name, function (error, item)
		{
			if (error)
			{
				return callback(error);
			}
			var shouldUpdate = !item || (moment(item.nextUpdate) < now);
			// return if we should not update
			if (!shouldUpdate)
			{
				log.info('Discarding package: ' + name);
				return callback(null);
			}
			// update!!
			estimator.estimate(entry, function (error, estimation)
			{
				if (error)
				{
					return callback(error);
				}
				// new entry?
				if (item && estimation)
				{
					estimation.created = null;
					estimation.timesUpdated = item.timesUpdated + 1;
					// should we defer the update one year
					var created = moment(item.created);
					var lastUpdated = moment(estimation.lastUpdated);
					var monthsAgo = lastUpdated.diff(created, 'months');
					if ((monthsAgo > 11) && (estimation.timesUpdated <= (monthsAgo + 1)))
					{
						estimation.nextUpdate = moment(lastUpdated).add(1, 'years').format();
					}
				}
				return callback (null, estimation);
			});
		});
	};
}

function getChunkProcessor(chunk)
{
	return function(callback)
	{
		log.info('About to process chunk: ' + chunk.length);
		async.parallel(chunk, function(error, estimations)
		{
			if (error)
			{
				log.error('Chunk processed with error ', error);
				return callback(error);
			}
			log.info('Chunk processed.');
			// Adjust pending, remaining calls, etc
			var pendings = [];
			var updates = [];
			var githubApiRemainingCalls = 9999999;
			var githubApiResetLimit;
			estimations.forEach(function (estimation)
			{
				if (!estimation || estimation.countProperties() === 0)
				{
					return;
				}
				if (estimation.githubApiRemainingCalls < githubApiRemainingCalls)
				{
					githubApiRemainingCalls = estimation.githubApiRemainingCalls;
					githubApiResetLimit = estimation.githubApiResetLimit;
				}
				delete estimation.githubApiRemainingCalls;
				delete estimation.githubApiResetLimit;
				if (estimation.pending)
				{
					var item = {
						pending: estimation.pending
					};
					delete estimation.pending;
					item.previousEstimation = estimation;
					pendings.push(item);
				}
				else
				{
					var finalEstimation = estimator.addQuality(estimation);
					updates.push(finalEstimation);
				}
			});
			// process updates, and then pendings
			var updatesPendingsStream = [];
			updatesPendingsStream.push(function (callback)
			{
				processUpdates(updates, callback);
			});
			updatesPendingsStream.push(function (result, callback)
			{
				processPendings(pendings, githubApiRemainingCalls, githubApiResetLimit, callback);
			});
			async.waterfall(updatesPendingsStream, function (error, result)
			{
				githubApiRemainingCalls = result.githubApiRemainingCalls;
				githubApiResetLimit = result.githubApiResetLimit;
				// check remaining api calls.
				if (githubApiRemainingCalls < limit)
				{
					var now = moment().unix();
					if (githubApiResetLimit > now)
					{
						var millisecondsToWait = (githubApiResetLimit - now) * 1000;
						log.info('Waiting ' + millisecondsToWait + ' milliseconds until next chunk');
						setTimeout(function()
						{
							return callback(null);
						}, millisecondsToWait);
					}
					else
					{
						return callback(null);
					}
				}
				else
				{
					return callback(null);
				}
			});
		});
	};
}

function processUpdates(estimations, callback)
{
	var updatesStream = [];
	estimations.forEach(function (estimation)
	{
		updatesStream.push(function (callback)
		{
			packages.update(estimation, function(error)
			{
				if (error)
				{
					log.error('Package ' + estimation.name + ' could not be upserted in the database: ' + JSON.stringify(error));
				}
				return callback(null);
			});
		});
	});
	async.parallel(updatesStream, callback);
}

function processPendings(pendings, githubApiRemainingCalls, githubApiResetLimit, callback)
{
	// stream the pending stuff 
	var pendingStream = [];
	pendings.forEach(function (pendingItem)
	{
		// only pending issues so far
		pendingStream.push(function (callback)
		{
			log.info('Processing pending for ' + pendingItem.previousEstimation.name);
			// function to process pending item
			function processPendingItem(pendingItem)
			{
				estimator.pending(pendingItem.pending, function (error, pendingEstimation)
				{
					githubApiRemainingCalls = pendingEstimation.githubApiRemainingCalls;
					githubApiResetLimit = pendingEstimation.githubApiResetLimit;
					delete pendingEstimation.githubApiRemainingCalls;
					delete pendingEstimation.githubApiResetLimit;
					var finalEstimation = estimator.addQuality(pendingItem.previousEstimation.concat(pendingEstimation));
					packages.update(finalEstimation, function(error)
					{
						if (error)
						{
							log.error('Package ' + finalEstimation.name + ' could not be upserted in the database: ' + JSON.stringify(error));
						}
						return callback(null);
					});
				});
			}
			// pending API calls
			var apiCallsForThisPending = pendingItem.pending[0].pages[1] - pendingItem.pending[0].pages[0] + 1;
			// check remaining api calls.
			if (githubApiRemainingCalls < apiCallsForThisPending)
			{
				var now = moment().unix();
				if (githubApiResetLimit > now)
				{
					var millisecondsToWait = (githubApiResetLimit - now) * 1000;
					log.info('Waiting in pendings ' + millisecondsToWait + ' milliseconds until next pending');
					setTimeout(function()
					{
						processPendingItem(pendingItem);
					}, millisecondsToWait);
				}
				else
				{
					processPendingItem(pendingItem);
				}
			}
			else
			{
				processPendingItem(pendingItem);
			}
		});
	});
	// run pending stream
	async.series(pendingStream, function()
	{
		return callback (null, {
			githubApiRemainingCalls: githubApiRemainingCalls,
			githubApiResetLimit: githubApiResetLimit
		});
	});
}

/************************************************
 **************** UNIT TESTS ********************
 ************************************************/
function testEstimatorNewEntry(callback)
{
	packages.setTestMode(function(error)
	{
		testing.check(error, 'Could not set test mode', callback);
		var newEntry = {name: 'newEntry'};
		var now = moment().format();
		var nextUpdate = moment(now).add(1, 'year').format();
		// stubs
		estimator = {
			estimate: function(entry, internalCallback) {
				testing.assertEquals(entry.name, newEntry.name, 'wrong entry passed to estimate', callback);
				return internalCallback(null, {
					name: entry.name,
					created: now,
					nextUpdate: nextUpdate,
					timesUpdated: 0
				});
			}
		};
		packages.remove(newEntry.name, function(error)
		{
			testing.check(error, 'Could not update package', callback);
			var theEstimator = getEstimator(newEntry);
			theEstimator(function(error, estimation) {
				testing.check(error, callback);
				testing.assertEquals(estimation.name, newEntry.name, 'wrong name returned by the estimator', callback);
				testing.assertEquals(estimation.created, now, 'wrong created returned by the estimator', callback);
				testing.assertEquals(estimation.nextUpdate, nextUpdate, 'wrong nextUpdate returned by the estimator', callback);
				testing.assertEquals(estimation.timesUpdated, 0, 'wrong timesUpdated returned by the estimator', callback);
				testing.success(callback);
			});
		});
	});
}

function testEstimatorExistingEntryShouldUpdate(callback)
{
	var existingEntry = {name: 'existingEntry'};
	var now = moment().format();
	var nextUpdate = moment(now).add(1, 'year').format();
	// stubs
	estimator = {
		estimate: function(entry, internalCallback) {
			testing.assertEquals(entry.name, existingEntry.name, 'wrong entry passed to estimate', callback);
			return internalCallback(null, {
				name: entry.name,
				created: now,
				nextUpdate: nextUpdate,
				timesUpdated: 0
			});
		}
	};
	var object = {
		name: existingEntry.name,
		nextUpdate: moment(now).subtract(1, 'second').format(),
		timesUpdated: 7,
	};
	packages.update(object, function(error)
	{
		testing.check(error, 'Could not update package', callback);
		var theEstimator = getEstimator(existingEntry);
		theEstimator(function(error, estimation) {
			testing.check(error, callback);
			testing.assertEquals(estimation.name, existingEntry.name, 'wrong name returned by the estimator', callback);
			testing.check(estimation.created, 'created should be deleted in existing entries', callback);
			testing.assertEquals(estimation.nextUpdate, nextUpdate, 'wrong nextUpdate returned by the estimator', callback);
			testing.assertEquals(estimation.timesUpdated, 8, 'wrong timesUpdated returned by the estimator', callback);
			testing.success(callback);
		});
	});
}

function testEstimatorExistingEntryShouldUpdateAndDefer(callback)
{
	var existingEntry = {name: 'existingEntry'};
	var now = moment().format();
	var nextUpdate = moment(now).add(1, 'month').format();
	// stubs
	estimator = {
		estimate: function(entry, internalCallback) {
			testing.assertEquals(entry.name, existingEntry.name, 'wrong entry passed to estimate', callback);
			return internalCallback(null, {
				name: entry.name,
				created: now,
				lastUpdated: now,
				nextUpdate: nextUpdate,
				timesUpdated: 0
			});
		}
	};
	var object = {
		name: existingEntry.name,
		created: moment(now).subtract(12, 'months').format(),
		nextUpdate: moment(now).subtract(1, 'second').format(),
		timesUpdated: 12,
	};
	packages.update(object, function(error)
	{
		testing.check(error, 'Could not update package', callback);
		var theEstimator = getEstimator(existingEntry);
		theEstimator(function(error, estimation) {
			testing.check(error, callback);
			testing.assertEquals(estimation.name, existingEntry.name, 'wrong name returned by the estimator', callback);
			testing.check(estimation.created, 'created should be deleted in existing entries', callback);
			testing.assertEquals(moment(estimation.nextUpdate).diff(now, 'years'), 1, 'wrong nextUpdate returned by the estimator', callback);
			testing.assertEquals(estimation.timesUpdated, 13, 'wrong timesUpdated returned by the estimator', callback);
			testing.success(callback);
		});
	});
}

function testEstimatorExistingEntryShouldNotUpdate(callback)
{
	var existingEntry = {name: 'existingEntry'};
	var now = moment();
	// stubs
	estimator = {
		estimate: function() {
			testing.check(true, 'estimate should never be called', callback);
		}
	};
	var object = {
		name: existingEntry.name,
		nextUpdate: moment(now).add(1, 'second').format(),
	};
	packages.update(object, function(error)
	{
		testing.check(error, 'Could not update package', callback);
		var theEstimator = getEstimator(existingEntry);
		theEstimator(function(error) {
			testing.check(error, callback);
			testing.success(callback);
		});
	});
}

function testChunkProcessorUndefinedEstimation(callback)
{
	var chunk = [];
	chunk.push(function (internalCallback) {
		return internalCallback(null);
	});
	var chunkProcessor = getChunkProcessor(chunk);
	chunkProcessor(function (error) {
		testing.check(error, callback);
		testing.success(callback);
	});
}

function testClose(callback)
{
	packages.close(callback);
}

/**
 * Run all tests.
 */
exports.test = function(callback)
{
	testing.run([
		testEstimatorNewEntry,
		testEstimatorExistingEntryShouldUpdate,
		testEstimatorExistingEntryShouldUpdateAndDefer,
		testEstimatorExistingEntryShouldNotUpdate,
		testChunkProcessorUndefinedEstimation,
		testClose,
	], callback);
};

// run tests if invoked directly
if (__filename == process.argv[1])
{
	exports.test(testing.show);
}
