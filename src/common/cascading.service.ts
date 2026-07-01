import {
  CommonServiceIds,
  getClient,
  IProjectPageService,
} from 'azure-devops-extension-api/Common';
import { WorkItemField } from 'azure-devops-extension-api/WorkItemTracking/WorkItemTracking';
import { WorkItemTrackingRestClient } from 'azure-devops-extension-api/WorkItemTracking/WorkItemTrackingClient';
import { IWorkItemFormService } from 'azure-devops-extension-api/WorkItemTracking/WorkItemTrackingServices';
import * as SDK from 'azure-devops-extension-sdk';
import flatten from 'lodash/flatten';
import intersection from 'lodash/intersection';
import uniq from 'lodash/uniq';
import {
  CascadeConfiguration,
  CascadeMap,
  ConditionMap,
  FieldOptions,
  FieldOptionsFlags,
  FieldOptionValue,
  IConditionalOption,
  ICascade,
} from './types';

type InvalidField = string;

class CascadingFieldsService {
  private workItemService: IWorkItemFormService;
  private cascadeMap: CascadeMap;
  /**
   * Reverse index mapping a field that is only referenced inside conditional
   * options (`when` clauses) to the affected fields that must be re-evaluated
   * when that field changes.
   */
  private fieldDependents: Record<string, Set<string>>;

  public constructor(
    workItemService: IWorkItemFormService,
    cascadeConfiguration: CascadeConfiguration
  ) {
    this.workItemService = workItemService;
    this.fieldDependents = {};
    this.cascadeMap = this.createCascadingMap(cascadeConfiguration);
  }

  private createCascadingMap(cascadeConfiguration: CascadeConfiguration): CascadeMap {
    const cascadeMap: CascadeMap = {};
    if (typeof cascadeConfiguration === 'undefined') {
      return cascadeMap;
    }

    Object.entries(cascadeConfiguration).map(([fieldName, fieldValues]) => {
      let alters: string[] = [];
      Object.values(fieldValues).map(cascadeDefinitions => {
        Object.entries(cascadeDefinitions).map(([field, optionValue]) => {
          alters.push(field);
          this.registerConditionDependents(field, optionValue);
        });
      });

      alters = uniq(alters);

      const cascade: ICascade = {
        alters,
        cascades: fieldValues,
      };

      cascadeMap[fieldName] = cascade;
    });
    return cascadeMap;
  }

  /**
   * Records that `affectedField` must be re-evaluated whenever any field used in
   * a conditional option's `when` clause changes.
   */
  private registerConditionDependents(affectedField: string, optionValue: FieldOptionValue): void {
    if (!this.isConditionalOptionList(optionValue)) {
      return;
    }
    optionValue.forEach(rule => {
      Object.keys(rule.when).forEach(conditionField => {
        if (!this.fieldDependents.hasOwnProperty(conditionField)) {
          this.fieldDependents[conditionField] = new Set<string>();
        }
        this.fieldDependents[conditionField].add(affectedField);
      });
    });
  }

  private isConditionalOptionList(
    optionValue: FieldOptionValue
  ): optionValue is IConditionalOption[] {
    return (
      Array.isArray(optionValue) &&
      optionValue.length > 0 &&
      typeof optionValue[0] === 'object' &&
      optionValue[0] !== null &&
      'when' in optionValue[0]
    );
  }

  /**
   * Evaluates a `when` clause against the current field values. All conditions
   * must be satisfied (logical AND).
   */
  private async evaluateCondition(condition: ConditionMap): Promise<boolean> {
    for (const [fieldName, expected] of Object.entries(condition)) {
      const currentValue = (await this.workItemService.getFieldValue(fieldName)) as string;
      if (typeof expected === 'object' && expected !== null && 'not' in expected) {
        if (currentValue === expected.not) {
          return false;
        }
      } else if (currentValue !== expected) {
        return false;
      }
    }
    return true;
  }

  /**
   * Resolves the allowed values contributed by a single option definition.
   * Returns `null` when the definition contributes no constraint (e.g. no
   * conditional rule matched the current field values).
   */
  private async resolveFieldOptionValue(
    field: string,
    optionValue: FieldOptionValue
  ): Promise<string[] | null> {
    if (typeof optionValue === 'string') {
      if (optionValue === FieldOptionsFlags.All) {
        return (await this.workItemService.getAllowedFieldValues(field)).map(value =>
          value.toString()
        );
      }
      return null;
    }

    if (this.isConditionalOptionList(optionValue)) {
      for (const rule of optionValue) {
        if (await this.evaluateCondition(rule.when)) {
          return this.resolveFieldOptionValue(field, rule.value);
        }
      }
      return null;
    }

    return optionValue as string[];
  }

  private getAffectedFields(fieldReferenceName: string, fieldValue: string): string[] {
    if (!this.cascadeMap[fieldReferenceName].cascades.hasOwnProperty(fieldValue)) {
      return [];
    }
    return Object.keys(this.cascadeMap[fieldReferenceName].cascades[fieldValue]);
  }

  private async validateFilterOrClean(fieldReferenceName: string): Promise<boolean> {
    const allowedValues: string[] = await (this
      .workItemService as any).getFilteredAllowedFieldValues(fieldReferenceName);
    const fieldValue = (await this.workItemService.getFieldValue(fieldReferenceName)) as string;
    if (!allowedValues.includes(fieldValue)) {
      return this.workItemService.setFieldValue(fieldReferenceName, '');
    }
  }

  public async resetAllCascades(): Promise<void[]> {
    const fields = flatten(Object.values(this.cascadeMap).map(value => value.alters));
    const fieldsToReset = new Set<string>(fields);
    return Promise.all(
      Array.from(fieldsToReset).map(async fieldName => {
        const values = await this.workItemService.getAllowedFieldValues(fieldName);
        await (this.workItemService as any).filterAllowedFieldValues(fieldName, values);
      })
    );
  }

  private async prepareCascadeOptions(affectedFields: string[]): Promise<FieldOptions> {
    const fieldValues: FieldOptions = {};

    await Promise.all(
      flatten(
        affectedFields.map(field => {
          return Object.entries(this.cascadeMap).map(async ([alterField, cascade]) => {
            if (cascade.alters.includes(field)) {
              const fieldValue = (await this.workItemService.getFieldValue(alterField)) as string;
              const optionsForValue = cascade.cascades[fieldValue];
              if (!optionsForValue || !optionsForValue.hasOwnProperty(field)) {
                return;
              }
              const cascadeOptions = await this.resolveFieldOptionValue(
                field,
                optionsForValue[field]
              );
              if (cascadeOptions === null) {
                return;
              }
              if (fieldValues.hasOwnProperty(field)) {
                fieldValues[field] = intersection(fieldValues[field] as string[], cascadeOptions);
              } else {
                fieldValues[field] = cascadeOptions;
              }
            }
          });
        })
      )
    );
    return fieldValues;
  }

  public async cascadeAll(): Promise<void[][]> {
    return Promise.all(
      Object.keys(this.cascadeMap).map(async field => this.performCascading(field))
    );
  }

  public async performCascading(changedFieldReferenceName: string): Promise<void[]> {
    const affectedFields = new Set<string>();

    if (this.cascadeMap.hasOwnProperty(changedFieldReferenceName)) {
      const changedFieldValue = (await this.workItemService.getFieldValue(
        changedFieldReferenceName
      )) as string;
      this.getAffectedFields(changedFieldReferenceName, changedFieldValue).forEach(field =>
        affectedFields.add(field)
      );
    }

    if (this.fieldDependents.hasOwnProperty(changedFieldReferenceName)) {
      this.fieldDependents[changedFieldReferenceName].forEach(field => affectedFields.add(field));
    }

    if (affectedFields.size === 0) {
      return;
    }

    const fieldValues = await this.prepareCascadeOptions(Array.from(affectedFields));

    return Promise.all(
      Object.entries(fieldValues).map(async ([fieldName, values]) => {
        await (this.workItemService as any).filterAllowedFieldValues(fieldName, values);
        await this.validateFilterOrClean(fieldName);
      })
    );
  }
}

interface ICascadeValidatorError {
  description: string;
}

class CascadeValidationService {
  private cachedFields: WorkItemField[];

  public async validateCascades(cascades: CascadeConfiguration): Promise<null | InvalidField[]> {
    const projectInfoService = await SDK.getService<IProjectPageService>(
      CommonServiceIds.ProjectPageService
    );
    const project = await projectInfoService.getProject();

    if (this.cachedFields == null) {
      const witRestClient = await getClient(WorkItemTrackingRestClient);
      const fields = await witRestClient.getFields(project.id);
      this.cachedFields = fields;
    }
    const fieldList = this.cachedFields.map(field => field.referenceName);

    // Check fields correctness for config root
    let invalidFieldsTotal = Object.keys(cascades).filter(field => !fieldList.includes(field));

    // Check fields on the lower level of config
    Object.values(cascades).map(fieldValues => {
      Object.values(fieldValues).map(innerFields => {
        const invalidFields = Object.keys(innerFields).filter(field => !fieldList.includes(field));
        invalidFieldsTotal = [...invalidFieldsTotal, ...invalidFields];

        // Check fields referenced inside conditional option `when` clauses
        Object.values(innerFields).map(optionValue => {
          if (
            Array.isArray(optionValue) &&
            optionValue.length > 0 &&
            typeof optionValue[0] === 'object' &&
            optionValue[0] !== null &&
            'when' in optionValue[0]
          ) {
            (optionValue as IConditionalOption[]).map(rule => {
              const invalidConditionFields = Object.keys(rule.when || {}).filter(
                field => !fieldList.includes(field)
              );
              invalidFieldsTotal = [...invalidFieldsTotal, ...invalidConditionFields];
            });
          }
        });
      });
    });

    if (invalidFieldsTotal.length > 0) {
      return invalidFieldsTotal;
    }

    return null;
  }
}

export { CascadingFieldsService, CascadeValidationService, ICascadeValidatorError };
