const mongoose = require('mongoose');

// Minimal schema with strict:false so all existing JSON fields pass through
// as-is. Only `id` and `email` need index enforcement.
const userSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  email: { type: String, unique: true },
  password: String,
}, { strict: false });

module.exports = mongoose.model('User', userSchema);
