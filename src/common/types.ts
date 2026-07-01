export type FieldName = string;

/**
 * A condition on a single field's current value. It either matches an exact
 * value (`string`) or any value except the given one (`{ not: string }`).
 */
export type ConditionValue = string | { not: string };

/**
 * A set of conditions on other fields. All entries are combined with a logical
 * AND, e.g. `{ "FieldA": "foo", "FieldB": { "not": "bar" } }` means
 * `FieldA == foo AND FieldB != bar`.
 */
export type ConditionMap = Record<FieldName, ConditionValue>;

/**
 * A conditional option definition: when every condition in `when` is satisfied,
 * the affected field is restricted to `value`.
 */
export interface IConditionalOption {
  when: ConditionMap;
  value: string[] | FieldOptionsFlags;
}

/**
 * The allowed values for an affected field. It can be an explicit list of
 * values, the `all` flag, or a list of conditional options that depend on the
 * current values of other fields.
 */
export type FieldOptionValue = string[] | FieldOptionsFlags | IConditionalOption[];
export type FieldOptions = Record<FieldName, FieldOptionValue>;
export type CascadeConfiguration = Record<FieldName, Record<FieldName, FieldOptions>>;
export type CascadeMap = Record<FieldName, ICascade>;

export enum FieldOptionsFlags {
  All = 'all',
}
export interface ICascade {
  alters: FieldName[];
  cascades: Record<FieldName, FieldOptions>;
}

export interface IManifest {
  version?: string;
  cascades?: CascadeConfiguration;
}

