const crypto = require('crypto');
const { validate: validateUUID } = require('uuid');

function hashPayload(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function validateIdempotencyKey(key) {
  return validateUUID(key);
}

module.exports = { hashPayload, validateIdempotencyKey };
