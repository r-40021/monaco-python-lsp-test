interface PyodideGlobals {
	set(name: string, value: unknown): void;
}

interface PyodideInterface {
	loadPackage(name: string | string[]): Promise<void>;
	runPythonAsync<T = unknown>(code: string): Promise<T>;
	globals: PyodideGlobals;
}

interface WorkerDiagnostic {
	line: number;
	column: number;
	message: string;
	severity: "error" | "warning";
}

interface WorkerCompletionItem {
	name: string;
	type: string;
	description: string;
	signature: string;
	docstring: string;
	insert_text: string;
}

interface WorkerHoverPayload {
	contents: {
		kind: "markdown";
		value: string;
	};
}

interface DefinitionResult {
	name: string;
	line: number | null;
	column: number | null;
	description: string;
}

type WorkerRequest =
	| { type: "initialize"; requestId: string }
	| { type: "analyze"; requestId: string; data: { code: string } }
	| {
			type: "completion";
			requestId: string;
			data: { code: string; line: number; column: number };
	  }
	| {
			type: "hover";
			requestId: string;
			data: { code: string; line: number; column: number };
	  }
	| {
			type: "definition";
			requestId: string;
			data: { code: string; line: number; column: number };
	  };

type WorkerResponse =
	| { type: "initialized"; requestId: string; success: boolean; error?: string }
	| {
			type: "analysis";
			requestId: string;
			data: { diagnostics: WorkerDiagnostic[] };
	  }
	| { type: "completion"; requestId: string; data: WorkerCompletionItem[] }
	| { type: "hover"; requestId: string; data: WorkerHoverPayload | null }
	| { type: "definition"; requestId: string; data: DefinitionResult[] };

interface MessageWorkerContext {
	postMessage(message: WorkerResponse): void;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<WorkerRequest>) => void,
	): void;
}

const workerCtx = self as unknown as MessageWorkerContext;

let pyodide: PyodideInterface | null = null;
let jediInitialized = false;

const PYODIDE_INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v0.25.0/full/";
const PYODIDE_MODULE_URL = `${PYODIDE_INDEX_URL}pyodide.mjs`;
const MAX_COMPLETIONS = 50;

type LoadPyodideFn = (options: {
	indexURL: string;
}) => Promise<PyodideInterface>;
let loadPyodideFn: LoadPyodideFn | null = null;

const INSTALL_SCRIPT = [
	"import micropip",
	'await micropip.install("jedi")',
	'await micropip.install("parso")',
].join("\n");

const createJediBootstrap = (maxCompletions: number): string =>
	[
		"import json",
		"import textwrap",
		"import jedi",
		"import parso",
		"",
		'project = jedi.Project(path="/")',
		"",
		'def _call_or_default(obj, attr_name, default_value=""):',
		"    attr = getattr(obj, attr_name, None)",
		"    if callable(attr):",
		"        try:",
		"            return attr()",
		"        except Exception:",
		"            return default_value",
		"    return attr if attr is not None else default_value",
		"",
		"def _clean_docstring(value):",
		"    if not value:",
		'        return ""',
		"    return textwrap.dedent(value).strip()",
		"",
		"def get_completions(code, line, column):",
		"    try:",
		"        script = jedi.Script(code, project=project)",
		"        completions = script.complete(line, column)",
		"        results = []",
		`        for item in completions[:${maxCompletions}]:`,
		"            signatures = item.get_signatures()",
		"            results.append({",
		'                "name": item.name or "",',
		'                "type": item.type or "",',
		'                "description": getattr(item, "description", "") or "",',
		'                "signature": str(signatures[0]) if signatures else "",',
		'                "docstring": _clean_docstring(_call_or_default(item, "docstring")),',
		'                "insert_text": getattr(item, "complete", None) or item.name or "",',
		"            })",
		"        return json.dumps(results)",
		"    except Exception:",
		"        return json.dumps([])",
		"",
		"def get_hover(code, line, column):",
		"    try:",
		"        script = jedi.Script(code, project=project)",
		"        names = script.help(line, column)",
		"        if names:",
		"            name = names[0]",
		"            signatures = name.get_signatures()",
		"            result = {",
		'                "name": name.name or "",',
		'                "type": name.type or "",',
		'                "description": getattr(name, "description", "") or "",',
		'                "docstring": _clean_docstring(_call_or_default(name, "docstring")),',
		'                "signature": str(signatures[0]) if signatures else "",',
		"            }",
		"            return json.dumps(result)",
		"        return json.dumps(None)",
		"    except Exception:",
		"        return json.dumps(None)",
		"",
		"def get_diagnostics(code):",
		"    try:",
		"        grammar = parso.load_grammar()",
		"        module = grammar.parse(code)",
		"        errors = grammar.iter_errors(module)",
		"        results = []",
		"        for error in errors:",
		"            results.append({",
		'                "line": error.start_pos[0],',
		'                "column": error.start_pos[1],',
		'                "message": error.message,',
		'                "severity": "error",',
		"            })",
		"        return json.dumps(results)",
		"    except Exception:",
		"        return json.dumps([])",
		"",
		"def get_definitions(code, line, column):",
		"    try:",
		"        script = jedi.Script(code, project=project)",
		"        definitions = script.goto(line, column)",
		"        results = []",
		"        for definition in definitions:",
		"            results.append({",
		'                "name": definition.name or "",',
		'                "line": definition.line,',
		'                "column": definition.column,',
		'                "description": getattr(definition, "description", "") or "",',
		"            })",
		"        return json.dumps(results)",
		"    except Exception:",
		"        return json.dumps([])",
	].join("\n");

async function initializeJedi(): Promise<void> {
	if (jediInitialized) {
		return;
	}

	try {
		console.log("Loading Pyodide script...");
		let loader = loadPyodideFn;
		if (!loader) {
			const module = await import(/* @vite-ignore */ PYODIDE_MODULE_URL);
			loader = module.loadPyodide as LoadPyodideFn;
			loadPyodideFn = loader;
		}

		console.log("Initializing Pyodide...");
		pyodide = await loader({ indexURL: PYODIDE_INDEX_URL });

		console.log("Installing Jedi dependencies...");
		await pyodide.loadPackage("micropip");
		await pyodide.runPythonAsync(INSTALL_SCRIPT);
		await pyodide.runPythonAsync(createJediBootstrap(MAX_COMPLETIONS));

		jediInitialized = true;
		console.log("Jedi initialized successfully");
	} catch (error) {
		console.error("Failed to initialize Jedi:", error);
		throw error;
	}
}

function getRuntime(): PyodideInterface | null {
	if (!pyodide || !jediInitialized) {
		return null;
	}

	return pyodide;
}

async function analyzeCode(code: string): Promise<WorkerDiagnostic[]> {
	const runtime = getRuntime();
	if (!runtime) {
		return [];
	}

	try {
		runtime.globals.set("user_code", code);
		const result = await runtime.runPythonAsync<string>(
			"get_diagnostics(user_code)",
		);
		return JSON.parse(result) as WorkerDiagnostic[];
	} catch (error) {
		console.error("Analysis error:", error);
		return [];
	}
}

async function getCompletions(
	code: string,
	line: number,
	column: number,
): Promise<WorkerCompletionItem[]> {
	const runtime = getRuntime();
	if (!runtime) {
		return [];
	}

	try {
		runtime.globals.set("user_code", code);
		runtime.globals.set("user_line", Math.max(1, line));
		runtime.globals.set("user_column", Math.max(0, column));
		const result = await runtime.runPythonAsync<string>(
			"get_completions(user_code, user_line, user_column)",
		);
		return JSON.parse(result) as WorkerCompletionItem[];
	} catch (error) {
		console.error("Completion error:", error);
		return [];
	}
}

async function getHover(
	code: string,
	line: number,
	column: number,
): Promise<WorkerHoverPayload | null> {
	const runtime = getRuntime();
	if (!runtime) {
		return null;
	}

	try {
		runtime.globals.set("user_code", code);
		runtime.globals.set("user_line", Math.max(1, line));
		runtime.globals.set("user_column", Math.max(0, column));
		const result = await runtime.runPythonAsync<string>(
			"get_hover(user_code, user_line, user_column)",
		);
		const parsed = JSON.parse(result) as {
			name: string;
			type: string;
			description: string;
			docstring: string;
			signature: string;
		} | null;
		if (!parsed) {
			return null;
		}
		const header = `**${parsed.name}** (${parsed.type})`;
		const details = [parsed.signature, parsed.docstring]
			.filter(Boolean)
			.join("\n\n");
		const value = details ? `${header}\n\n${details}` : header;
		return {
			contents: {
				kind: "markdown",
				value,
			},
		};
	} catch (error) {
		console.error("Hover error:", error);
		return null;
	}
}

async function getDefinitions(
	code: string,
	line: number,
	column: number,
): Promise<DefinitionResult[]> {
	const runtime = getRuntime();
	if (!runtime) {
		return [];
	}

	try {
		runtime.globals.set("user_code", code);
		runtime.globals.set("user_line", Math.max(1, line));
		runtime.globals.set("user_column", Math.max(0, column));
		const result = await runtime.runPythonAsync<string>(
			"get_definitions(user_code, user_line, user_column)",
		);
		return JSON.parse(result) as DefinitionResult[];
	} catch (error) {
		console.error("Definitions error:", error);
		return [];
	}
}

function respond(message: WorkerResponse): void {
	workerCtx.postMessage(message);
}

workerCtx.addEventListener(
	"message",
	async (event: MessageEvent<WorkerRequest>) => {
		const { type, requestId } = event.data;

		switch (type) {
			case "initialize": {
				try {
					await initializeJedi();
					respond({ type: "initialized", requestId, success: true });
				} catch (error) {
					respond({
						type: "initialized",
						requestId,
						success: false,
						error: String(error),
					});
				}
				break;
			}
			case "analyze": {
				const diagnostics = await analyzeCode(event.data.data.code);
				respond({ type: "analysis", requestId, data: { diagnostics } });
				break;
			}
			case "completion": {
				const { code, line, column } = event.data.data;
				const completions = await getCompletions(code, line, column);
				respond({ type: "completion", requestId, data: completions });
				break;
			}
			case "hover": {
				const { code, line, column } = event.data.data;
				const hover = await getHover(code, line, column);
				respond({ type: "hover", requestId, data: hover });
				break;
			}
			case "definition": {
				const { code, line, column } = event.data.data;
				const definitions = await getDefinitions(code, line, column);
				respond({ type: "definition", requestId, data: definitions });
				break;
			}
			default: {
				console.warn("Unknown worker request:", event.data);
			}
		}
	},
);

console.log("Jedi worker started");
