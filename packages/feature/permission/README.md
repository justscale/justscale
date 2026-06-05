# @justscale/permission

Model-level permission declarations with typed guards. Permissions are declared once on the model and reused by HTTP guards, service checks, and the OpenAPI generator.

## Install

```bash
pnpm add @justscale/permission
```

## Usage

```ts
import { permit, PermissionFeature, AbstractPrincipalProvider } from '@justscale/permission';
import { defineModel, field } from '@justscale/core/models';

class Product extends defineModel({
  name: 'Product',
  fields: {
    name: field.string(),
    seller: field.ref(User),
  },
}) {
  static can = {
    view: permit(User).always(),
    edit: permit(User).when(() => Product.fields.seller),
    delete: [
      permit(User).when(() => Product.fields.seller),
      permit(Admin).always(),
    ],
  };
}

// In a controller:
Get('/products/:productRef')
  .types({ Product })
  .guard(Product.can.view)
  .handle(async ({ params }) => params.productRef);
```

`PermissionFeature` wires the guards into the request pipeline. Your app supplies at least one `AbstractPrincipalProvider` (contributions aggregate) so the guards can resolve who's making the request.

## Docs

https://justscale.sh/features/permissions
