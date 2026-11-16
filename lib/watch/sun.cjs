'use strict';

/**
 * The sun's elevation at the vessel, from its own position and the time.
 *
 * Solar charging, panel voltage and the charger modes that follow them have
 * a day and a night, and judging the night by the day's baseline (or the
 * other way round) reports every sunset. No sun path is needed for this: the
 * low-precision solar position (the Astronomical Almanac's, good to about
 * 0.01° in declination for this century) is enough to tell day from night
 * anywhere a GNSS fix is.
 */

const RAD = Math.PI / 180;

function normalizeDegrees(value) {
  const result = value % 360;
  return result < 0 ? result + 360 : result;
}

/** Elevation of the sun's centre above the horizon, in degrees, without refraction. */
function sunElevationDeg(latitude, longitude, t) {
  // Days since J2000.0 (2000-01-01 12:00 UT).
  const d = t / 86400000 + 2440587.5 - 2451545.0;
  const meanAnomaly = normalizeDegrees(357.529 + 0.98560028 * d) * RAD;
  const meanLongitude = normalizeDegrees(280.459 + 0.98564736 * d);
  const eclipticLongitude =
    normalizeDegrees(meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * RAD;
  const obliquity = (23.439 - 0.00000036 * d) * RAD;
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const siderealDegrees = normalizeDegrees(280.46061837 + 360.98564736629 * d + longitude);
  const hourAngle = siderealDegrees * RAD - rightAscension;
  const lat = latitude * RAD;
  const sinElevation = Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinElevation))) / RAD;
}

module.exports = { sunElevationDeg };
