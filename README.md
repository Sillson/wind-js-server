# wind-js-server

Simple demo rest service to expose [GRIB2](http://en.wikipedia.org/wiki/GRIB) wind forecast data 
(1 degree, 6 hourly from [NOAA](http://nomads.ncep.noaa.gov/)) as JSON. <br/>

Contains a pre-packaged copy of [grib2json](https://github.com/cambecc/grib2json) for conversion.

## install, run:

(assumes you have node and npm installed)

```bash
# from project root:
npm install
npm start
```

## endpoints
- **/latest** returns the most up to date JSON data available
- **/nearest** returns JSON data nearest to requested
	- $GET params:
		- `timeIso` an ISO timestamp for temporal target
		- `searchLimit` number of days to search beyond the timeIso (will search backwards, then forwards)
- **/alive** health check url, returns simple message

## License
MIT License (MIT)