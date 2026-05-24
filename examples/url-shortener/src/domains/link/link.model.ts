import { defineModel, field } from '@justscale/core/models';

// A link is pure domain data. Storage owns the row id; our code never sees it -
// the slug is the only identifier the domain cares about.
export class Link extends defineModel({
  name: 'Link',
  fields: {
    slug: field.string().max(16).unique(),
    target: field.text(),
    hits: field.int().default(0),
  },
}) {}
