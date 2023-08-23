import { HassEntities } from 'home-assistant-js-websocket';
import { cloneDeep } from 'lodash';
import selectn from 'selectn';

import ExposeAsMixin from '../../common/controllers/ExposeAsMixin';
import InputOutputController, {
    InputOutputControllerOptions,
} from '../../common/controllers/InputOutputController';
import ConfigError from '../../common/errors/ConfigError';
import ComparatorService from '../../common/services/ComparatorService';
import State from '../../common/State';
import TransformState, { TransformType } from '../../common/TransformState';
import { isRecord } from '../../helpers/assert';
import { renderTemplate } from '../../helpers/mustache';
import { containsMustache, shouldIncludeEvent } from '../../helpers/utils';
import { HaEvent } from '../../homeAssistant';
import { HassEntity, HassStateChangedEvent } from '../../types/home-assistant';
import { NodeMessage } from '../../types/nodes';
import { EntityConfigNode } from '../entity-config';
import { TriggerStateNode, TriggerStateProperties } from '.';
import {
    ComparatorPropertyType,
    Constraint,
    CustomOutput,
    ENABLE,
    MessageType,
    PropertyType,
    TargetType,
} from './const';

interface DefaultMessage {
    topic: string;
    payload: unknown;
    data: Record<string, unknown>;
    failedComparators?: any[];
}

interface CustomOutputsComparatorResult {
    output: CustomOutput;
    comparatorMatched: boolean;
    actualValue: unknown;
    message: Record<string, unknown> | null;
}

interface TriggerEvent {
    entity_id: string;
    new_state: HassEntity | null;
    old_state: HassEntity | null;
}

interface TargetData {
    entityId: string;
    state: HassEntity | TriggerEvent;
}

interface ComparatorResult {
    constraint: Constraint;
    constraintTarget: TargetData;
    actualValue: unknown;
    comparatorResult: boolean;
}

export interface TriggerStateControllerConstructor
    extends InputOutputControllerOptions<
        TriggerStateNode,
        TriggerStateProperties
    > {
    comparatorService: ComparatorService;
    exposeAsConfigNode?: EntityConfigNode;
    state?: State;
    transformState: TransformState;
}

const ExposeAsController = ExposeAsMixin(
    InputOutputController<TriggerStateNode, TriggerStateProperties>
);
export default class TriggerStateController extends ExposeAsController {
    #comparatorService: ComparatorService;
    #state?: State;
    #transformState: TransformState;

    constructor(props: TriggerStateControllerConstructor) {
        super(props);
        this.#comparatorService = props.comparatorService;
        this.#state = props.state;
        this.#transformState = props.transformState;
    }

    get isEnabled(): boolean {
        if (this.exposeAsConfigNode) {
            return super.isEnabled;
        }

        return this.#state?.isEnabled() ?? true;
    }

    #getConstraintComparatorResults(
        constraints: Constraint[],
        eventMessage: HassStateChangedEvent
    ) {
        const comparatorResults: ComparatorResult[] = [];

        // Check constraints
        for (const constraint of constraints) {
            const {
                comparatorType,
                comparatorValue,
                comparatorValueDatatype,
                propertyValue,
            } = constraint;
            const constraintTarget = this.#getConstraintTargetData(
                constraint,
                eventMessage.event
            );
            const actualValue = selectn(
                constraint.propertyValue,
                constraintTarget.state
            );
            const comparatorResult =
                this.#comparatorService.getComparatorResult(
                    comparatorType,
                    comparatorValue,
                    actualValue,
                    comparatorValueDatatype,
                    {
                        entity: eventMessage.event.new_state,
                        prevEntity: eventMessage.event.old_state,
                    }
                );
            if (comparatorResult === false) {
                this.debugToClient(
                    `constraint comparator: failed entity "${constraintTarget.entityId}" property "${propertyValue}" with value ${actualValue} failed "${comparatorType}" check against (${comparatorValueDatatype}) ${comparatorValue}`
                );
            }

            comparatorResults.push({
                constraint,
                constraintTarget,
                actualValue,
                comparatorResult,
            });
        }
        const failedComparators = comparatorResults.filter(
            (res) => !res.comparatorResult
        );
        return {
            all: comparatorResults,
            failed: failedComparators,
        };
    }

    #getConstraintTargetData(
        constraint: Constraint,
        triggerEvent: TriggerEvent
    ) {
        const isTargetThisEntity =
            constraint.targetType === TargetType.ThisEntity;
        const entityId = isTargetThisEntity
            ? triggerEvent.entity_id
            : constraint.targetValue;
        const entity = isTargetThisEntity
            ? triggerEvent
            : (this.homeAssistant.websocket.getStates(entityId) as HassEntity);

        if (entity === null) {
            throw new ConfigError([
                'trigger-state.error.entity_not_found',
                { entity_id: entityId },
            ]);
        }

        const targetData: TargetData = {
            entityId,
            state: entity,
        };

        if (
            !isTargetThisEntity &&
            constraint.propertyType === PropertyType.CurrentState
        ) {
            targetData.state = {
                entity_id: entityId,
                old_state: null,
                new_state: this.homeAssistant.websocket.getStates(
                    entityId
                ) as HassEntity,
            };
        }

        return targetData;
    }

    #getCustomOutputsComparatorResults(
        outputs: CustomOutput[],
        eventMessage: HassStateChangedEvent
    ) {
        return outputs.reduce((acc, output) => {
            const result: CustomOutputsComparatorResult = {
                output,
                comparatorMatched: true,
                actualValue: null,
                message: null,
            };

            if (
                output.comparatorPropertyType !== ComparatorPropertyType.Always
            ) {
                result.actualValue = selectn(
                    output.comparatorPropertyValue,
                    eventMessage.event
                );
                result.comparatorMatched =
                    this.#comparatorService.getComparatorResult(
                        output.comparatorType,
                        output.comparatorValue,
                        result.actualValue,
                        output.comparatorValueDataType,
                        {
                            entity: eventMessage.event.new_state,
                            prevEntity: eventMessage.event.old_state,
                        }
                    );
            }
            result.message = this.#getOutputMessage(result, eventMessage);
            acc.push(result);
            return acc;
        }, [] as CustomOutputsComparatorResult[]);
    }

    #getDefaultMessageOutputs(
        comparatorResults: any,
        eventMessage: HassStateChangedEvent
    ) {
        const { entity_id: entityId, event } = eventMessage;

        const msg: DefaultMessage = {
            topic: entityId,
            payload: event.new_state?.state,
            data: eventMessage,
        };
        let outputs;

        if (comparatorResults.failed.length) {
            this.debugToClient(
                'constraint comparator: one or more comparators failed to match constraints, message will send on the failed output'
            );

            msg.failedComparators = comparatorResults.failed;
            outputs = [null, msg];
        } else {
            outputs = [msg, null];
        }
        return outputs;
    }

    #getOutputMessage(
        {
            output,
            comparatorMatched,
            actualValue,
        }: CustomOutputsComparatorResult,
        eventMessage: HassStateChangedEvent
    ): Record<string, unknown> {
        // If comparator did not match
        if (!comparatorMatched) {
            this.debugToClient(
                `output comparator failed: property "${output.comparatorPropertyValue}" with value ${actualValue} failed "${output.comparatorType}" check against (${output.comparatorValueDataType}) ${output.comparatorValue}`
            );
            return {};
        }

        let message: Record<string, unknown> = {
            topic: eventMessage.entity_id,
            payload: eventMessage.event.new_state?.state,
            data: eventMessage,
        };

        if (
            output.messageType === MessageType.Custom ||
            output.messageType === MessageType.Payload
        ) {
            let payload = output.messageValue;
            // Render Template Variables
            if (containsMustache(output.messageValue)) {
                payload = renderTemplate(
                    output.messageValue,
                    eventMessage.event as NodeMessage,
                    this.node.context(),
                    this.homeAssistant.websocket.getStates()
                );
            }

            payload = this.typedInputService.getValue(
                payload,
                output.messageValueType,
                {
                    eventData: eventMessage,
                }
            );

            if (output.messageType === MessageType.Custom) {
                if (!isRecord(payload)) {
                    throw new ConfigError(
                        'trigger-state.error.custom_output_message_needs_to_be_object'
                    );
                }
                message = payload;
            } else {
                message = {
                    payload,
                };
            }
        }

        return message;
    }

    public onInputEnabled(message: NodeMessage): boolean {
        const enable = message.payload === ENABLE;
        this.#state?.setEnabled(enable);
        this.enableExposeAs(enable);
        return true;
    }

    public onInputTesting(message: NodeMessage): boolean {
        const {
            entity_id: entityId,
            new_state: newState,
            old_state: oldState,
        } = message.payload as TriggerEvent;
        if (entityId && newState && oldState) {
            const evt = {
                event_type: HaEvent.StateChanged,
                entity_id: entityId,
                event: message.payload,
            };

            this.onEntityStateChanged(evt as HassStateChangedEvent);
        }
        return true;
    }

    public onDeploy() {
        if (this.isEnabled === false) {
            return;
        }

        const entities = this.homeAssistant.websocket.getStates();
        this.onStatesLoaded(entities);
    }

    public onStatesLoaded(entities: HassEntities) {
        if (this.isEnabled === false) {
            return;
        }

        for (const entityId in entities) {
            const eventMessage = {
                event_type: HaEvent.StateChanged,
                entity_id: entityId,
                event: {
                    entity_id: entityId,
                    old_state: entities[entityId],
                    new_state: entities[entityId],
                },
            };

            this.onEntityStateChanged(eventMessage as HassStateChangedEvent);
        }
    }

    public onEntityStateChanged(evt: HassStateChangedEvent) {
        if (
            this.isEnabled === false ||
            !this.homeAssistant.isHomeAssistantRunning
        ) {
            return;
        }

        const eventMessage = cloneDeep(evt);

        if (
            !eventMessage.event.new_state ||
            !shouldIncludeEvent(
                eventMessage.entity_id,
                this.node.config.entityId,
                this.node.config.entityIdType
            )
        ) {
            return;
        }

        // Convert and save original state if needed
        if (
            eventMessage.event.old_state &&
            this.node.config.stateType !== TransformType.String
        ) {
            eventMessage.event.old_state.original_state = eventMessage.event
                .old_state.state as string;
            eventMessage.event.old_state.state = this.#transformState.transform(
                this.node.config.stateType,
                eventMessage.event.old_state.state as string
            );
        }
        if (
            eventMessage.event.new_state &&
            this.node.config.stateType !== TransformType.String
        ) {
            eventMessage.event.new_state.original_state = eventMessage.event
                .new_state.state as string;
            eventMessage.event.new_state.state = this.#transformState.transform(
                this.node.config.stateType,
                eventMessage.event.new_state.state as string
            );
        }

        eventMessage.event.new_state.timeSinceChangedMs =
            Date.now() -
            new Date(eventMessage.event.new_state.last_changed).getTime();

        const constraintComparatorResults =
            this.#getConstraintComparatorResults(
                this.node.config.constraints,
                eventMessage
            );

        let outputs: (DefaultMessage | Record<string, unknown> | null)[] =
            this.#getDefaultMessageOutputs(
                constraintComparatorResults,
                eventMessage
            );

        const stateString = eventMessage.event.new_state.state.toString();
        // If a constraint comparator failed we're done, also if no custom outputs to look at
        if (
            constraintComparatorResults.failed.length ||
            !this.node.config.customOutputs.length
        ) {
            if (constraintComparatorResults.failed.length) {
                this.status.setFailed(stateString);
            } else {
                this.status.setSuccess(stateString);
            }
            this.debugToClient(`done processing sending messages:`);
            this.debugToClient(outputs);

            this.node.send(outputs);
            return;
        }

        const customOutputsComparatorResults =
            this.#getCustomOutputsComparatorResults(
                this.node.config.customOutputs,
                eventMessage
            );
        const customOutputMessages = customOutputsComparatorResults.map(
            (r) => r.message
        );

        outputs = outputs.concat(customOutputMessages);
        this.debugToClient(`done processing sending messages: ${outputs}`);
        this.status.setSuccess(stateString);
        this.node.send(outputs);
    }
}
