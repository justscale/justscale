import { defineMigration } from '@justscale/postgres'

export default defineMigration({
  name: '2026_04_21_233714_init',
  async up({ db }) {
    await db.raw(`CREATE TYPE RoomVisibility AS ENUM ('public', 'private')`)
    await db.raw(`CREATE TYPE MembershipRole AS ENUM ('owner', 'moderator', 'member')`)
    await db.raw(`CREATE TABLE IF NOT EXISTS process_signal_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1,
  instance_id VARCHAR(512) NOT NULL,
  type VARCHAR(10) NOT NULL DEFAULT 'signal',
  signal VARCHAR(255),
  identity JSON NOT NULL DEFAULT '{}',
  branches JSON,
  status VARCHAR(20) NOT NULL DEFAULT 'waiting',
  matched_payload JSON,
  matched_branch_id VARCHAR(64),
  queued_payloads JSON NOT NULL DEFAULT '[]'
)`)
    await db.raw(`CREATE TABLE IF NOT EXISTS process_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1,
  process_id VARCHAR(255) NOT NULL,
  instance_id VARCHAR(512) NOT NULL UNIQUE,
  code_version VARCHAR(64) NOT NULL,
  pc INTEGER NOT NULL DEFAULT 0,
  variables JSON NOT NULL DEFAULT '{}',
  timers JSON NOT NULL DEFAULT '[]',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  result JSON,
  error TEXT,
  last_error TEXT,
  last_error_at DATE,
  suspended_at DATE,
  completed_at DATE
)`)
    await db.raw(`CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100),
  email_verified_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  two_factor_secret VARCHAR(255),
  two_factor_enabled BOOLEAN NOT NULL DEFAULT false
)`)
    await db.raw(`CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1,
  user_id UUID NOT NULL,
  token VARCHAR(255) NOT NULL,
  user_agent VARCHAR(500),
  ip_address VARCHAR(45),
  expires_at TIMESTAMPTZ NOT NULL,
  last_active_at TIMESTAMPTZ NOT NULL
)`)
    await db.raw(`CREATE TABLE IF NOT EXISTS permission_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  granted BOOLEAN NOT NULL DEFAULT true
)`)
    await db.raw(`CREATE TABLE IF NOT EXISTS chat_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1,
  name VARCHAR(64) NOT NULL UNIQUE,
  topic VARCHAR(256),
  visibility RoomVisibility NOT NULL DEFAULT 'public',
  created_by_id UUID NOT NULL
)`)
    await db.raw(`CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1,
  room_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role MembershipRole NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL,
  muted_until TIMESTAMPTZ,
  banned_until TIMESTAMPTZ
)`)
    await db.raw(`CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1,
  room_id UUID NOT NULL,
  author_id UUID NOT NULL,
  text VARCHAR(2000) NOT NULL,
  posted_at TIMESTAMPTZ NOT NULL
)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_process_signal_subscriptions_created_at ON process_signal_subscriptions(created_at)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_process_signal_subscriptions_updated_at ON process_signal_subscriptions(updated_at)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_process_executions_created_at ON process_executions(created_at)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_process_executions_updated_at ON process_executions(updated_at)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_users_updated_at ON users(updated_at)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_permission_grants_created_at ON permission_grants(created_at)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_permission_grants_updated_at ON permission_grants(updated_at)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_chat_rooms_created_at ON chat_rooms(created_at)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_chat_rooms_updated_at ON chat_rooms(updated_at)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_memberships_created_at ON memberships(created_at)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_memberships_updated_at ON memberships(updated_at)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`)
    await db.raw(`CREATE INDEX IF NOT EXISTS idx_messages_updated_at ON messages(updated_at)`)
    await db.raw(`ALTER TABLE sessions ADD CONSTRAINT fk_sessions_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE NO ACTION ON UPDATE NO ACTION`)
    await db.raw(`ALTER TABLE chat_rooms ADD CONSTRAINT fk_chat_rooms_created_by_id FOREIGN KEY (created_by_id) REFERENCES users(id) ON DELETE NO ACTION ON UPDATE NO ACTION`)
    await db.raw(`ALTER TABLE memberships ADD CONSTRAINT fk_memberships_room_id FOREIGN KEY (room_id) REFERENCES chat_rooms(id) ON DELETE NO ACTION ON UPDATE NO ACTION`)
    await db.raw(`ALTER TABLE memberships ADD CONSTRAINT fk_memberships_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE NO ACTION ON UPDATE NO ACTION`)
    await db.raw(`ALTER TABLE messages ADD CONSTRAINT fk_messages_room_id FOREIGN KEY (room_id) REFERENCES chat_rooms(id) ON DELETE NO ACTION ON UPDATE NO ACTION`)
    await db.raw(`ALTER TABLE messages ADD CONSTRAINT fk_messages_author_id FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE NO ACTION ON UPDATE NO ACTION`)
  },

  async down({ db }) {
    await db.dropForeignKey('messages', 'fk_messages_author_id')
    await db.dropForeignKey('messages', 'fk_messages_room_id')
    await db.dropForeignKey('memberships', 'fk_memberships_user_id')
    await db.dropForeignKey('memberships', 'fk_memberships_room_id')
    await db.dropForeignKey('chat_rooms', 'fk_chat_rooms_created_by_id')
    await db.dropForeignKey('sessions', 'fk_sessions_user_id')
    await db.dropIndex('idx_messages_updated_at')
    await db.dropIndex('idx_messages_created_at')
    await db.dropIndex('idx_memberships_updated_at')
    await db.dropIndex('idx_memberships_created_at')
    await db.dropIndex('idx_chat_rooms_updated_at')
    await db.dropIndex('idx_chat_rooms_created_at')
    await db.dropIndex('idx_permission_grants_updated_at')
    await db.dropIndex('idx_permission_grants_created_at')
    await db.dropIndex('idx_sessions_updated_at')
    await db.dropIndex('idx_sessions_created_at')
    await db.dropIndex('idx_users_updated_at')
    await db.dropIndex('idx_users_created_at')
    await db.dropIndex('idx_process_executions_updated_at')
    await db.dropIndex('idx_process_executions_created_at')
    await db.dropIndex('idx_process_signal_subscriptions_updated_at')
    await db.dropIndex('idx_process_signal_subscriptions_created_at')
    await db.dropTable('messages')
    await db.dropTable('memberships')
    await db.dropTable('chat_rooms')
    await db.dropTable('permission_grants')
    await db.dropTable('sessions')
    await db.dropTable('users')
    await db.dropTable('process_executions')
    await db.dropTable('process_signal_subscriptions')
    await db.dropType('MembershipRole')
    await db.dropType('RoomVisibility')
  },
})
