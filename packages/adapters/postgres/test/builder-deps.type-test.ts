/**
 * Type-level tests for createClusterBuilder dependency checking.
 *
 * These tests verify that the builder correctly catches missing dependencies
 * at compile time, not just runtime. They use @ts-expect-error to assert
 * that certain code SHOULD fail to compile.
 *
 * Run with: pnpm typecheck (or tsc --noEmit)
 */

import { defineModel, field } from '@justscale/core/models';
import JustScale, {
  bindService,
  AbstractChannelBackend,
  MemoryChannelBackend,
} from '@justscale/core';
import { defineService } from '@justscale/core';
import {
  createPostgresClient,
  createPgModel,
  createPgRepository,
  ModelChangeChannels,
} from '../src/index.js';

// ============================================================================
// Test Models & Services
// ============================================================================

class Author extends defineModel({
  name: field.string().max(255),
  email: field.string().max(255),
}) {}

class Comment extends defineModel({
  body: field.text(),
  author: field.ref(Author),
}) {}

const PgAuthor = createPgModel(Author, { table: 'authors', storageMode: 'columnar' });
const PgComment = createPgModel(Comment, { table: 'comments', storageMode: 'columnar' });

const AuthorRepository = createPgRepository(PgAuthor);
const CommentRepository = createPgRepository(PgComment);

const PostgresClient = createPostgresClient({ connectionString: 'postgres://localhost/test' });

// Service that depends on CommentRepository
const CommentService = defineService({
  inject: { comments: CommentRepository },
  factory: ({ comments }) => ({
    findAll: () => comments.find({}),
  }),
});

// Service that depends on both repositories
const ArticleService = defineService({
  inject: { comments: CommentRepository, authors: AuthorRepository },
  factory: ({ comments, authors }) => ({
    getComments: () => comments.find({}),
    getAuthors: () => authors.find({}),
  }),
});

// ============================================================================
// Type Tests: Missing Dependencies Should Cause Compile Errors
// ============================================================================

// TEST 1: Adding CommentService without CommentRepository should fail
JustScale()
  .add(PostgresClient)
  // @ts-expect-error - CommentService requires CommentRepository which is not registered
  .add(CommentService);

// TEST 2: Adding CommentRepository without PostgresClient should fail
JustScale()
  // @ts-expect-error - CommentRepository requires PostgresClient (AbstractPostgresClient)
  .add(CommentRepository);

// TEST 3: Adding ArticleService without AuthorRepository should fail
JustScale()
  .add(PostgresClient)
  .add(CommentRepository)
  // @ts-expect-error - ArticleService requires AuthorRepository which is not registered
  .add(ArticleService);

// ============================================================================
// Type Tests: Correct Order Should Compile Successfully
// ============================================================================

// TEST 4: Correct order should work (no error expected)
JustScale()
  .add(PostgresClient)
  .add(MemoryChannelBackend)
  .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
  .add(ModelChangeChannels)
  .add(CommentRepository)
  .add(CommentService)
  .build();

// TEST 5: Full chain with all dependencies should work
JustScale()
  .add(PostgresClient)
  .add(MemoryChannelBackend)
  .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
  .add(ModelChangeChannels)
  .add(AuthorRepository)
  .add(CommentRepository)
  .add(ArticleService)
  .add(CommentService)
  .build();

// TEST 6: Order of independent repositories doesn't matter
JustScale()
  .add(PostgresClient)
  .add(MemoryChannelBackend)
  .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
  .add(ModelChangeChannels)
  .add(CommentRepository)  // CommentRepository first
  .add(AuthorRepository)   // AuthorRepository second
  .add(ArticleService)     // Works because both are registered
  .build();
