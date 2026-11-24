/**
 * 4-Layer Brick Contract for ProjectX
 * Every brick exposes:
 * Layer 1: D1 Database Migrations (SQL)
 * Layer 2: Hono REST API Routes (Server)
 * Layer 3: Cloudflare Workflow Step / Runtime Executor (Workflow)
 * Layer 4: Client Widget / UI Screen (Client)
 *
 * Schemas are defined canonical in @poc/assembler (packages/assembler/src/schemas.ts)
 * and imported here to guarantee single-source schema validation across the codebase.
 */

import {
  settingDeprecated as SettingDeprecatedSchema,
  settingDefinition as SettingDefinitionSchema,
  routeDefinition as RouteDefinitionSchema,
  privacyTableDefinition as PrivacyTableDefinitionSchema,
  privacyDefinition as PrivacyDefinitionSchema,
  workerPrivacyDefinition as WorkerPrivacyDefinitionSchema,
  ManifestSchema as BrickManifestSchema,
  nodePortDataType as PortDataTypeSchema,
  nodePortDefinition as PortDescriptorSchema,
  type SettingDeprecated,
  type SettingDefinition,
  type RouteDefinition,
  type PrivacyTableDefinition,
  type PrivacyDefinition,
  type WorkerPrivacyDefinition,
  type NodePortDataType as PortDataType,
  type NodePortDefinition as PortDescriptor,
  type BrickManifestFile as BrickManifest,
} from "../packages/assembler/src/schemas.ts";

export {
  PortDataTypeSchema,
  type PortDataType,
  PortDescriptorSchema,
  type PortDescriptor,
  SettingDeprecatedSchema,
  type SettingDeprecated,
  SettingDefinitionSchema,
  type SettingDefinition,
  RouteDefinitionSchema,
  type RouteDefinition,
  PrivacyTableDefinitionSchema,
  type PrivacyTableDefinition,
  PrivacyDefinitionSchema,
  type PrivacyDefinition,
  WorkerPrivacyDefinitionSchema,
  type WorkerPrivacyDefinition,
  BrickManifestSchema,
  type BrickManifest,
};
