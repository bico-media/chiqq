/// <reference types="node" />
export interface Configuration {
    concurrency?: number;
    chill?: number;
    paused?: boolean;
    retryMax?: number;
    retryCooling?: number;
    retryFactor?: number;
}
export interface ConfigTask {
    chill?: number;
    retryCooling?: number;
    addAsFirst?: boolean;
}
export default class Chiqq {
    concurrency: number;
    conf: {
        retryMax: number;
        retryCooling: number;
        retryFactor: number;
        chill: number;
    };
    running: number;
    paused: boolean;
    q: any;
    constructor(conf: Configuration);
    tick(): Promise<void>;
    add(task: () => any, configObj?: ConfigTask): Promise<unknown>;
    pause(): void;
    resume(): void;
    next(configObj?: ConfigTask): Promise<void> | NodeJS.Timeout;
    insight(): {
        concurrency: number;
        paused: boolean;
        qLength: any;
        running: number;
        chill: number;
        retryMax: number;
        retryCooling: number;
        retryFactor: number;
    };
}
