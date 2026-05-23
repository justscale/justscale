/**
 * Example usage of the HTTP Route Builder
 *
 * This demonstrates the HTTP builder factory.
 */

import { Get, Post, Put, Delete } from '../src/builder/index.js'
import { z } from 'zod'

// Example 1: Simple GET route
const getUserRoute = Get('/users/:id')
  .use((ctx) => {
    // Add custom middleware
    return { userId: ctx.params.id }
  })
  .returns(200, z.object({ id: z.string(), name: z.string() }))
  .handle((ctx) => {
    // Handler has access to userId from middleware
    console.log('Fetching user:', ctx.userId)
    ctx.res.status(200).json({ id: ctx.userId, name: 'John Doe' })
  })

// Example 2: POST route with body validation
const createUserRoute = Post('/users')
  .body(z.object({
    name: z.string(),
    email: z.string().email()
  }))
  .returns(201, z.object({ id: z.string(), name: z.string(), email: z.string() }))
  .handle((ctx) => {
    // Handler has access to validated body
    console.log('Creating user:', ctx.body.name, ctx.body.email)
    ctx.res.status(201).json({
      id: '123',
      name: ctx.body.name,
      email: ctx.body.email
    })
  })

// Example 3: GET route with query validation
const listUsersRoute = Get('/users')
  .query(z.object({
    page: z.string(),
    limit: z.string()
  }))
  .returns(200, z.array(z.object({ id: z.string(), name: z.string() })))
  .handle((ctx) => {
    // Handler has access to validated query params
    console.log('Listing users:', ctx.query.page, ctx.query.limit)
    ctx.res.status(200).json([])
  })

// Example 4: Using guards for authentication
const protectedRoute = Get('/admin/users')
  .guard((ctx) => {
    // Check authentication
    if (!ctx.req.headers.authorization) {
      ctx.res.status(401).json({ error: 'Unauthorized' })
      return ctx.stop()
    }
  })
  .use((ctx) => ({ isAdmin: true }))
  .handle((ctx) => {
    // Only executed if guard passes
    console.log('Admin access:', ctx.isAdmin)
    ctx.res.status(200).json({ users: [] })
  })

// Example 5: Chaining multiple middleware
const complexRoute = Put('/users/:id')
  .use((ctx) => ({ userId: ctx.params.id }))
  .guard((ctx) => {
    if (!ctx.userId) {
      ctx.res.status(400).json({ error: 'Invalid user ID' })
      return ctx.stop()
    }
  })
  .body(z.object({ name: z.string() }))
  .use((ctx) => ({ timestamp: Date.now() }))
  .returns(200, z.object({ id: z.string(), name: z.string() }))
  .handle((ctx) => {
    console.log('Updating user:', ctx.userId, ctx.body.name, ctx.timestamp)
    ctx.res.status(200).json({ id: ctx.userId, name: ctx.body.name })
  })

console.log('HTTP Route Builders created successfully!')
console.log('getUserRoute method:', getUserRoute.method)
console.log('createUserRoute method:', createUserRoute.method)
console.log('listUsersRoute method:', listUsersRoute.method)
console.log('protectedRoute method:', protectedRoute.method)
console.log('complexRoute method:', complexRoute.method)
