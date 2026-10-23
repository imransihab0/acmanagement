/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as catalogue from "../catalogue.js";
import type * as costs from "../costs.js";
import type * as courses from "../courses.js";
import type * as customers from "../customers.js";
import type * as danger from "../danger.js";
import type * as dashboard from "../dashboard.js";
import type * as fixedCosts from "../fixedCosts.js";
import type * as investment from "../investment.js";
import type * as migrateToR2 from "../migrateToR2.js";
import type * as migrateToR2Queries from "../migrateToR2Queries.js";
import type * as migrations from "../migrations.js";
import type * as orders from "../orders.js";
import type * as otp from "../otp.js";
import type * as portal from "../portal.js";
import type * as productCategories from "../productCategories.js";
import type * as products from "../products.js";
import type * as profit from "../profit.js";
import type * as r2 from "../r2.js";
import type * as sales from "../sales.js";
import type * as seed from "../seed.js";
import type * as shared from "../shared.js";
import type * as stock from "../stock.js";
import type * as traineeAuth from "../traineeAuth.js";
import type * as trainees from "../trainees.js";
import type * as vendorCategories from "../vendorCategories.js";
import type * as vendors from "../vendors.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  catalogue: typeof catalogue;
  costs: typeof costs;
  courses: typeof courses;
  customers: typeof customers;
  danger: typeof danger;
  dashboard: typeof dashboard;
  fixedCosts: typeof fixedCosts;
  investment: typeof investment;
  migrateToR2: typeof migrateToR2;
  migrateToR2Queries: typeof migrateToR2Queries;
  migrations: typeof migrations;
  orders: typeof orders;
  otp: typeof otp;
  portal: typeof portal;
  productCategories: typeof productCategories;
  products: typeof products;
  profit: typeof profit;
  r2: typeof r2;
  sales: typeof sales;
  seed: typeof seed;
  shared: typeof shared;
  stock: typeof stock;
  traineeAuth: typeof traineeAuth;
  trainees: typeof trainees;
  vendorCategories: typeof vendorCategories;
  vendors: typeof vendors;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
