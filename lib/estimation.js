'use strict';

/**
 * Read info about a package and estimate its quality.
 * (C) 2014 Alex Fernández.
 */

// requires
var request = require('basic-request');
var testing = require('testing');
var Log = require('log');

// globals
var log = new Log('debug');


/**
 * Estimate the quality of a package.
 */
exports.estimate = function(entry, callback)
{
	if (!entry.repository)
	{
		return callback(null, 0);
	}
	return estimateByName(entry.name, callback);
};

/**
 * Estimate the quality of a package by name between 0 and 1.
 */
function estimateByName(name, callback)
{
	var url = 'http://registry.npmjs.org/' + name;
	log.debug('Registry URL: %s', url);
	request.get(url, function(error, body)
	{
		if (error)
		{
			if (body.statusCode == 404)
			{
				return callback(null, 0);
			}
			log.error('Could not read registry for ' + name + ' (' + url + '): ' + error);
			return callback(null, 0);
		}
		var result;
		try
		{
			result = JSON.parse(body);
		}
		catch(exception)
		{
			return callback('Could not parse ' + name + ': ' + exception);
		}
		var quality = 1;
		estimateVersions(result.versions, function(error, versionQuality)
		{
			if (error)
			{
				return callback(error);
			}
			estimateRepo(result.repository, function(error, repoQuality)
			{
				if (error)
				{
					return callback(error);
				}
				quality *= repoQuality * versionQuality;
				log.debug('Quality: %s', quality);
				return callback(null, quality);
			});
		});
	});
}

function estimateVersions(versions, callback)
{
	if (!versions)
	{
		return callback(null, 0);
	}
	var number = versions.countProperties();
	log.debug('Versions %s', number);
	return callback(null, 1 - 1 / number);
}

function estimateRepo(repo, callback)
{
	log.debug('Repo %j', repo);
	if (!repo)
	{
		return callback(null, 0);
	}
	if (repo.type != 'git')
	{
		log.info('Repo is not git: %s', repo.type);
		return callback(null, 0);
	}
	var info = extractRepoInfo(repo.url);
	if (!info.valid)
	{
		log.error('Invalid repo URL ' + repo.url);
		return callback(null, 0);
	}
	var issuesUrl = 'https://api.github.com/repos/' + info.owner + '/' + info.name + '/issues?per_page=1000&state=all';
	log.debug('URL for issues: %s', issuesUrl);
	request.get(issuesUrl, function(error, result)
	{
		if (error)
		{
			log.error('Could not access issues on ' + issuesUrl + ': ' + error);
			return callback(null, 0);
		}
		var issues;
		try
		{
			issues = JSON.parse(result);
		}
		catch(exception)
		{
			return callback('Invalid issues in ' + result + ': ' + exception);
		}
		var open = 0;
		var closed = 0;
		var total = 0;
		issues.forEach(function(issue)
		{
			total += 1;
			if (issue.state == 'open')
			{
				open += 1;
			}
			else if (issue.state == 'closed')
			{
				closed += 1;
			}
			else
			{
				log.error('Invalid state %s', issue.state);
			}
		});
		if (!total)
		{
			log.debug('No issues in %s', issues);
			return callback(null, 0);
		}
		log.debug('Issues: %s / %s open', open, total);
		return callback(null, 1 - open / total);
	});
}

function extractRepoInfo(url)
{
	if (url.startsWith('git@github.com:'))
	{
		return extractPieces(url.substringFrom('git@github.com:'), 0);
	}
	return extractPieces(url, 3);
}

function extractPieces(remaining, initial)
{
	var pieces = remaining.split('/');
	if (pieces.length != initial + 2)
	{
		log.error('Invalid URL %s', remaining);
		return {};
	}
	return {
		valid: true,
		owner: pieces[initial],
		name: pieces[initial + 1].substringUpTo('.git'),
	};
}

function testEstimation(callback)
{
	var name = 'loadtest';
	estimateByName(name, function(error, result)
	{
		testing.check(error, 'Could not read %s', name, callback);
		testing.assert(result, 'No result', callback);
		testing.success(callback);
	});
}

/**
 * Run all tests.
 */
exports.test = function(callback)
{
	testing.run([
		testEstimation,
	], 10000, callback);
};

// run tests if invoked directly
if (__filename == process.argv[1])
{
	exports.test(testing.show);
}
