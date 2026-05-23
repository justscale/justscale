/**
 * Example: Proto imports in TypeScript
 *
 * This demonstrates how @justscale/typescript enables native .proto imports.
 * TypeScript will resolve './user.proto' to a generated declaration file
 * that provides full type safety.
 */

import { User, UserRole, CreateUserRequest, CreateUserResponse } from './user.proto'

// Example: Using proto-generated types with full type safety
function createUser(request: CreateUserRequest): CreateUserResponse {
  const user: User = {
    id: crypto.randomUUID(),
    email: request.email,
    name: request.name,
    role: request.role,
    tags: [],
  }

  return { user }
}

// Example: Type inference works correctly
const request: CreateUserRequest = {
  email: 'user@example.com',
  name: 'John Doe',
  role: UserRole.ROLE_USER,
}

const response = createUser(request)
console.log('Created user:', response.user?.name)

// Example: TypeScript catches type errors
// Uncommenting the following would cause a type error:
// const invalidUser: User = {
//   id: '123',
//   email: 'test@example.com',
//   invalidField: 'error', // Error: 'invalidField' does not exist in type 'User'
// }

export { createUser, request }
