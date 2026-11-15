'use strict';

/**
 * Which kind of quantity a Signal K path carries, decided by its leaf: an
 * angle (radians), a temperature (kelvin) or a speed (metres per second). The
 * watch reads values in operator units and treats angles as circular.
 */

// Signal K carries angles in radians. Matching is on the LAST segment only,
// and on a fixed list.
//
// Anything ending in a non-angle unit is excluded explicitly, because Signal K
// nests real angles under course* too (navigation.courseGreatCircle.
// bearingTrackTrue is radians; .distance is not).
const ANGLE_LEAF = new RegExp(
  '^(?:' +
    [
      'angle[A-Za-z0-9_]*',
      'heading[A-Za-z0-9_]*',
      'bearing[A-Za-z0-9_]*',
      'course[A-Za-z0-9_]*',
      'track[A-Za-z0-9_]*',
      'directionTrue',
      'directionMagnetic',
      'rateOfTurn',
      'roll',
      'pitch',
      'yaw',
      'set'
    ].join('|') +
    ')$'
);

// Leaves that live under an angle-ish parent but are emphatically not angles.
const NON_ANGLE_LEAF = /^(?:distance|velocityMadeGood|speed[A-Za-z0-9_]*|time[A-Za-z0-9_]*|latitude|longitude|altitude|crossTrackError|position)$/;

// An angle word is not always the first word of a camelCase leaf
// (`sensors.headingHold.fusedHeading`). The word has to begin a camelCase
// segment, so this matches fusedHeading, desiredHeading and targetBearing
// without matching a word that merely contains the letters. NON_ANGLE_LEAF is
// still consulted first, which keeps crossTrackError - a distance - out.
const ANGLE_SUFFIX_LEAF =
  /[a-z0-9](?:Angle|Heading|Bearing|Course|Track|Direction|Roll|Pitch|Yaw)[A-Za-z0-9_]*$/;

function isAnglePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    return false;
  }

  const leaf = path.slice(path.lastIndexOf('.') + 1);
  if (NON_ANGLE_LEAF.test(leaf)) {
    return false;
  }

  return ANGLE_LEAF.test(leaf) || ANGLE_SUFFIX_LEAF.test(leaf);
}

// Signal K carries temperatures in kelvin and speeds in metres per second.
const TEMPERATURE_LEAF = /^(?:[A-Za-z0-9_]*[Tt]emperature|dewPoint)$/;

// NON_ANGLE_LEAF already keeps every one of these off the angle path, so the
// two lists cannot both claim a leaf.
const SPEED_LEAF = /^(?:speed[A-Za-z0-9_]*|velocityMadeGood|gust)$/;

function leafOf(path) {
  return typeof path === 'string' ? path.slice(path.lastIndexOf('.') + 1) : '';
}

function isTemperaturePath(path) {
  return TEMPERATURE_LEAF.test(leafOf(path));
}

function isSpeedPath(path) {
  return SPEED_LEAF.test(leafOf(path));
}

module.exports = {
  isAnglePath,
  isSpeedPath,
  isTemperaturePath
};
