import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

const KrogerSnapshotSchema = new mongoose.Schema(
  {
    accessToken: String,
    refreshToken: String,
    expiresAt: Date,
    locationId: String,
    // Local snapshot of items your app added (UPC -> qty)
    cartSnapshot: { type: Map, of: Number, default: {} },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  cart: { type: Map, of: Number, default: {} },
  kroger: { type: KrogerSnapshotSchema, default: {} },
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

export default mongoose.model('User', userSchema);
