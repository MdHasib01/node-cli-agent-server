import { connectDatabase, disconnectDatabase } from '../src/db.js';
import { User } from '../src/models/User.js';
import { hashPassword } from '../src/services/authService.js';

async function seed() {
  const email = (process.argv[2] || 'admin@hasibdev.online').toLowerCase().trim();
  const password = process.argv[3] || 'hasib123';
  const name = process.argv[4] || 'Admin';
  const role = process.argv[5] || 'admin';

  console.log('Connecting to database...');
  await connectDatabase();
  console.log('Connected to MongoDB.');

  const passwordHash = await hashPassword(password);

  const existing = await User.findOne({ email });
  if (existing) {
    existing.name = name || existing.name;
    existing.passwordHash = passwordHash;
    existing.role = role;
    existing.status = 'active';
    existing.sessionVersion = (existing.sessionVersion || 0) + 1;
    await existing.save();
    console.log(`Updated existing user: ${existing.email} (Role: ${existing.role}, ID: ${existing._id})`);
  } else {
    const user = await User.create({
      name,
      email,
      passwordHash,
      role,
      status: 'active',
    });
    console.log(`Created user: ${user.email} (Role: ${user.role}, ID: ${user._id})`);
  }

  await disconnectDatabase();
  console.log('Database disconnected. Seed complete.');
}

seed().catch((err) => {
  console.error('Failed to seed user:', err);
  process.exit(1);
});
