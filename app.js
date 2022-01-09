var express = require("express");
var moment = require("moment");
var http = require('http');
var request = require('request');
var fs = require('fs');
const fsp = require('fs').promises;
var Q = require('q');
var cors = require('cors');
var AWS = require('aws-sdk');

AWS.config.update({region: 'us-west-2'});

// Create S3 service object
var s3 = new AWS.S3({apiVersion: '2006-03-01'});
var BUCKET_NAME = 'airfire-data-exports';
var WIND_PREFIX = 'maps/wind/'

var app = express();
var port = process.env.PORT || 7000;
var baseDir ='http://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl';

app.set('json spaces', 20);
app.set('title', 'WindJS')

// cors config
var whitelist = [
	'http://localhost:63342',
	'http://localhost:3000',
	'http://localhost:4000'
];

var corsOptions = {
	origin: function(origin, callback){
		var originIsWhitelisted = whitelist.indexOf(origin) !== -1;
		callback(null, originIsWhitelisted);
	}
};

app.listen(port, function(err){
	console.log("running server on port "+ port);
});

app.get('/', cors(corsOptions), function(req, res){
    res.send('hello wind-js-server.. go to /latest for wind data..');
});

// app.get('/s3', cors(corsOptions), function(req, res){
// 	res.setHeader('Content-Type', 'application/json');

// 	var params = {
// 	 Bucket: 'airfire-data-exports',
// 	 Delimiter: '/',
// 	 Prefix: WIND_PREFIX
// 	}

// 	async function getBuckets() {
// 		AWS.config.update({region: 'us-west-2'});
// 		s3 = new AWS.S3({apiVersion: '2006-03-01'});
// 		s3.listObjectsv2(params, function(err, data) {
// 		  if (err) {
// 		    console.log("Error", err);
// 		    res.send(JSON.stringify({error: "bigtime"}));
// 		  } else {
// 		    console.log("Success");
// 		    console.log(data.Contents);
// 		    res.send(JSON.stringify(data.Contents));
// 		  }
// 		});
// 	};
// });


app.get('/latest', cors(corsOptions), function(req, res){

	/**
	 * Find and return the latest available 6 hourly pre-parsed JSON data
	 *
	 * @param targetMoment {Object} UTC moment
	 */
	function sendLatest(targetMoment){

		var stamp = moment(targetMoment).format('YYYYMMDD') + roundHours(moment(targetMoment).hour(), 6);
		var fileName = __dirname +"/json-data/"+ stamp +".json";

		res.setHeader('Content-Type', 'application/json');
		res.sendFile(fileName, {}, function (err) {
			if (err) {
				console.log(stamp +' doesnt exist yet, trying previous interval..');
				sendLatest(moment(targetMoment).subtract(6, 'hours'));
			}
		});
	}

	sendLatest(moment().utc());

});

app.get('/nearest', cors(corsOptions), function(req, res, next){

	var time = req.query.timeIso;
	var limit = req.query.searchLimit;
	var searchForwards = false;

	/**
	 * Find and return the nearest available 6 hourly pre-parsed JSON data
	 * If limit provided, searches backwards to limit, then forwards to limit before failing.
	 *
	 * @param targetMoment {Object} UTC moment
	 */
	function sendNearestTo(targetMoment){

		if( limit && Math.abs( moment.utc(time).diff(targetMoment, 'days'))  >= limit) {
			if(!searchForwards){
				searchForwards = true;
				sendNearestTo(moment(targetMoment).add(limit, 'days'));
				return;
			}
			else {
				return next(new Error('No data within searchLimit'));
			}
		}

		var stamp = moment(targetMoment).format('YYYYMMDD') + roundHours(moment(targetMoment).hour(), 6);
		var fileName = __dirname +"/json-data/"+ stamp +".json";

		res.setHeader('Content-Type', 'application/json');
		res.sendFile(fileName, {}, function (err) {
			if(err) {
				var nextTarget = searchForwards ? moment(targetMoment).add(6, 'hours') : moment(targetMoment).subtract(6, 'hours');
				sendNearestTo(nextTarget);
			}
		});
	}

	if(time && moment(time).isValid()){
		sendNearestTo(moment.utc(time));
	}
	else {
		return next(new Error('Invalid params, expecting: timeIso=ISO_TIME_STRING'));
	}

});

/**
 *
 * Ping for new data every 15 mins
 *
 */
setInterval(function(){

	run(moment.utc());

}, 900000);

setInterval(function(){
	console.log('Pushing latest to s3');
	latestToS3()
}, 10000);

/**
 *
 * @param targetMoment {Object} moment to check for new data
 */
function run(targetMoment){

	getGribData(targetMoment).then(function(response){
		if(response.stamp){
			convertGribToJson(response.stamp, response.targetMoment);
		}
	});
}

/**
 *
 * Finds and returns the latest 6 hourly GRIB2 data from NOAAA
 *
 * @returns {*|promise}
 */
function getGribData(targetMoment){

	var deferred = Q.defer();

	function runQuery(targetMoment){

        // only go 2 weeks deep
		if (moment.utc().diff(targetMoment, 'days') > 30){
	        console.log('hit limit, harvest complete or there is a big gap in data..');
            return;
        }

		var stamp = moment(targetMoment).format('YYYYMMDD') + roundHours(moment(targetMoment).hour(), 6);
		var urlstamp = stamp.slice(0,8)+'/'+stamp.slice(8,10)+'/atmos';

		request.get({
			url: baseDir,
			qs: {
				file: 'gfs.t'+ roundHours(moment(targetMoment).hour(), 6) +'z.pgrb2.1p00.f000',
				lev_10_m_above_ground: 'on',
				lev_surface: 'on',
				var_TMP: 'on',
				var_UGRD: 'on',
				var_VGRD: 'on',
				leftlon: 0,
				rightlon: 360,
				toplat: 90,
				bottomlat: -90,
				dir: '/gfs.'+urlstamp
			}

		}).on('error', function(err){
			// console.log(err);
			runQuery(moment(targetMoment).subtract(6, 'hours'));

		}).on('response', function(response) {

			console.log('response '+response.statusCode + ' | '+stamp);

			if(response.statusCode != 200){
				runQuery(moment(targetMoment).subtract(6, 'hours'));
			}

			else {
				// don't rewrite stamps
				if(!checkPath('json-data/'+ stamp +'.json', false)) {

					console.log('piping ' + stamp);

					// mk sure we've got somewhere to put output
					checkPath('grib-data', true);

					// pipe the file, resolve the valid time stamp
					var file = fs.createWriteStream("grib-data/"+stamp+".f000");
					response.pipe(file);
					file.on('finish', function() {
						file.close();
						deferred.resolve({stamp: stamp, targetMoment: targetMoment});
					});

				}
				else {
					console.log('already have '+ stamp +', not looking further');
					deferred.resolve({stamp: false, targetMoment: false});
				}
			}
		});

	}

	runQuery(targetMoment);
	return deferred.promise;
}

async function convertGribToJson(stamp, targetMoment){

	// mk sure we've got somewhere to put output
	checkPath('json-data', true);

	var exec = require('child_process').exec, child;

	child = exec('converter/bin/grib2json --data --output json-data/'+stamp+'.json --names --compact grib-data/'+stamp+'.f000',
		{maxBuffer: 500*1024},
		function (error, stdout, stderr){

			if(error){
				console.log('exec error: ' + error);
			}

			else {
				console.log("converted..");
				pushGribToS3(stamp);
				console.log("pushed to s3")

				// don't keep raw grib data
				exec('rm grib-data/*');

				// if we don't have older stamp, try and harvest one
				var prevMoment = moment(targetMoment).subtract(6, 'hours');
				var prevStamp = prevMoment.format('YYYYMMDD') + roundHours(prevMoment.hour(), 6);

				if(!checkPath('json-data/'+ prevStamp +'.json', false)){

					console.log("attempting to harvest older data "+ stamp);
					run(prevMoment);
				}

				else {
					console.log('got older, no need to harvest further');
				}
			}
		});
}

/**
 *
 * Round hours to expected interval, e.g. we're currently using 6 hourly interval
 * i.e. 00 || 06 || 12 || 18
 *
 * @param hours
 * @param interval
 * @returns {String}
 */
function roundHours(hours, interval){
	if(interval > 0){
		var result = (Math.floor(hours / interval) * interval);
		return result < 10 ? '0' + result.toString() : result;
	}
}

/**
 *
 * Push latest file to S3
 * @param filename {String} for s3
 * @param file body {String} to pipe to s3
 *
 */

function latestToS3(){
	return new Promise(function (resolve, reject){
		const jsonFolder = './json-data/';

		var f_array = []

		fs.readdirSync(jsonFolder).forEach(file => {
	  		f_array.push(file);
		});

		var f_sorted = f_array.sort();
		var latest_file_key = f_sorted.length - 1
		var latest_file = f_sorted[latest_file_key]
		if (latest_file) {
			console.log('Found latest file as: ' + latest_file)
			var filePath = 'json-data/' + latest_file;
			var s3Target = WIND_PREFIX + 'latest.json';
			fsp.readFile(filePath).then(data => {
				var params = {
			        Bucket: BUCKET_NAME,
			        Key: s3Target,
			        Body: data,
			        ACL: 'public-read',
			        ContentType: 'application/json',
			    };

			    s3.upload(params,
			      function (err, result) {
			        if (err) {
			          reject(err);
			          return;
			        }
			        console.log(result.Location)
			        resolve(result.Location);
			      }
			    );
			});
		}
	})
};



function pushGribToS3(stamp){
	return new Promise(function (resolve, reject) {
		var fileName = stamp + '.json'
		var filePath = 'json-data/' + fileName
		var s3Target = WIND_PREFIX + fileName

		fsp.readFile(filePath).then(data => {
			var params = {
		        Bucket: BUCKET_NAME,
		        Key: s3Target,
		        Body: data,
		        ACL: 'public-read',
		        ContentType: 'application/json',
		    };

		    s3.upload(params,
		      function (err, result) {
		        if (err) {
		          reject(err);
		          return;
		        }
		        resolve(result.Location);
		      }
		    );
		});
	});
}

/**
 * Sync check if path or file exists
 *
 * @param path {string}
 * @param mkdir {boolean} create dir if doesn't exist
 * @returns {boolean}
 */
function checkPath(path, mkdir) {
    try {
	    fs.statSync(path);
	    return true;

    } catch(e) {
        if(mkdir){
	        fs.mkdirSync(path);
        }
	    return false;
    }
}

// init harvest
run(moment.utc());