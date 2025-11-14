const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    displayName: { type: String, required: true },
    avatarUrl: { type: String, default: "" },
    online: { type: Boolean, default: false },
    lastSeen: { type: Date, default: null },
});

module.exports = mongoose.model('User', UserSchema);