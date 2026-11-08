#!/usr/bin/env node
/**
 * Generates src/lib/fluidnc/schema.json from FluidNC's field reference (docs/config_items.yaml):
 * type, range, enum values, default and description for every config field, so the settings
 * editor can explain each setting and check values.
 *
 *   node scripts/build-fluidnc-schema.mjs [path/to/config_items.yaml]
 *
 * Without an argument it downloads the file at the pinned commit below. The reference comes from
 * FluidNC main (newer than the v4.0.1 firmware), so a few fields may not exist on older firmware.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const COMMIT = 'e928c5e1db';
const SOURCE = `https://raw.githubusercontent.com/bdring/FluidNC/${COMMIT}/FluidNC/docs/config_items.yaml`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src/lib/fluidnc/schema.json');

const text = process.argv[2]
  ? fs.readFileSync(process.argv[2], 'utf8')
  : await (await fetch(SOURCE)).text();
const doc = parse(text, { maxAliasCount: -1 });

const META = new Set(['enum_types', 'pin_namespaces', 'section_meta', 'spindle_sections', 'vfd_protocol_fields', 'vfd_named_types']);
const unquote = (v) => (typeof v === 'string' ? v.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1') : v);

const fields = {};
for (const [section, entries] of Object.entries(doc)) {
  if (META.has(section) || !entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
  // "(top-level machine items)" → "", "axes.<letter>.motorN" → "axes/<letter>/motorN"
  const prefix = section.startsWith('(') ? '' : section.replace(/\./g, '/');
  for (const [name, spec] of Object.entries(entries)) {
    if (!spec || typeof spec !== 'object' || !spec.type) continue;
    const key = prefix ? `${prefix}/${name}` : name;
    const field = { type: spec.type, description: String(spec.description || '').trim() };
    if (spec.default !== undefined) field.default = String(unquote(spec.default));
    if (spec.default_note) field.defaultNote = String(spec.default_note);
    if (spec.min !== undefined) field.min = Number(spec.min);
    if (spec.max !== undefined) field.max = Number(spec.max);
    if (Array.isArray(spec.values)) field.values = spec.values.map(String);
    if (spec.tuning) field.tuning = String(spec.tuning);
    if (spec.pin_attributes) field.pinAttributes = String(spec.pin_attributes);
    fields[key] = field;
  }
}

const sections = {};
for (const key of Object.keys(fields)) {
  const parts = key.split('/');
  for (let i = 1; i < parts.length; i++) sections[parts.slice(0, i).join('/')] = true;
}

fs.writeFileSync(
  out,
  `${JSON.stringify({ source: { repo: 'bdring/FluidNC', commit: COMMIT, file: 'FluidNC/docs/config_items.yaml' }, fields }, null, 0)}\n`,
);
console.log(`${Object.keys(fields).length} fields, ${Object.keys(sections).length} sections → ${path.relative(root, out)}`);
