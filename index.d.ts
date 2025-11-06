interface Configuration {
	concurrency?: number;
	chill?: number;
	paused?: false;
	retryMax?: number;
	retryCooling?: number;
	retryFactor?: number;
}

interface ConfigTask {
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

	add(task: () => any, configObj?: ConfigTask): Promise<any>;

	pause(): void;

	resume(): void;

	next(configObj?: ConfigTask): number | void;

	insight(): {
		concurrency: number;
		paused: boolean;
		qLength: number;
		running: number;
		chill: number;
		retryMax: number;
		retryCooling: number;
		retryFactor: number;
	};
}

export {Configuration, ConfigTask};
