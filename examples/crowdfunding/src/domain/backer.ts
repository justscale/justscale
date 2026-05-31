import { defineModel, field } from '@justscale/core/models';

export const ShippingAddressShape = {
  street: field.string().max(255),
  city: field.string().max(100),
  state: field.string().max(100),
  postalCode: field.string().max(20),
  country: field.string().max(100),
};

export class Backer extends defineModel({
  fields: {
    name: field.string().max(255),
    email: field.string().max(255).unique(),
    shippingAddress: field.object(ShippingAddressShape).optional(),
    createdAt: field.createdAt(),
    updatedAt: field.updatedAt(),
  },
}) {}
