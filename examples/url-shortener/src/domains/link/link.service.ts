import { defineService } from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import { Link } from './link.model.js';

// The service IS the business logic - plain methods over an injected repository.
// No transport, no SQL, no locking ceremony leaking in. Inject the abstract
// ModelRepository.of(Link); the bootstrap wires the concrete Postgres one.
export class LinkService extends defineService({
  inject: { links: ModelRepository.of(Link) },
  factory: ({ links }) => ({
    // Create a short link for a target URL.
    async shorten(target: string) {
      const slug = Math.random().toString(36).slice(2, 8);
      return links.insert({ slug, target });
    },

    // Resolve a slug and count the hit. The counter update needs a Locked<Link>
    // - the only way to mutate an entity - so concurrent hits can't lose a
    // count, whether the app runs on one instance or many. The lock is released
    // at the end of the block.
    async resolve(slug: string) {
      const link = await links.findOne(Link.fields.slug.eq(slug));
      if (!link) return null;
      {
        using locked = await links.lock(link);
        if (locked) {
          await links.update(locked, { hits: locked.hits + 1 });
        }
      }
      return link;
    },
  }),
}) {}
