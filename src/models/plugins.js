/** Shared toJSON options: expose `id` instead of `_id` and never serialise secrets. */
export const toJSON = {
  virtuals: true,
  versionKey: false,
  transform(doc, ret) {
    if (ret._id !== undefined) {
      ret.id = String(ret._id);
      delete ret._id;
    }
    delete ret.passwordHash;
    delete ret.tokenHash;
    delete ret.sessionVersion;
    return ret;
  },
};

/** Options for embedded schemas that should serialise as plain objects. */
export const embedded = { _id: false, id: false };
