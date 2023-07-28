import BaseError, { BaseErrorData } from './BaseError';

export default class InputError extends BaseError {
    constructor(data: BaseErrorData, statusMessage?: BaseErrorData) {
        super({
            data,
            statusMessage,
            name: 'InputError',
            defaultStatusMessage: 'home-assistant.status.failed',
        });
    }
}
