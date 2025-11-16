/* eslint-disable @typescript-eslint/no-explicit-any */
import { useRef, useEffect, useState, useCallback } from "react";
import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import PyrightWorker from "../src/pyright.worker?worker";

interface MonacoEditorProps {
	value?: string;
	onChange?: (value: string | undefined) => void;
	language?: string;
	theme?: "vs-dark" | "light" | "vs";
	height?: string;
	className?: string;
	readOnly?: boolean;
}

export default function MonacoEditor({
	value = "",
	onChange,
	language = "python",
	theme = "vs-dark",
	height = "600px",
	className = "",
	readOnly = false,
}: MonacoEditorProps) {
	const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
	const workerRef = useRef<Worker | null>(null);
	const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
	const [isWorkerReady, setIsWorkerReady] = useState(false);
	const requestIdCounter = useRef(0);
	const pendingRequests = useRef(
		new Map<string, (response: WorkerResponse | null) => void>(),
	);
	const providerDisposables = useRef<Array<{ dispose: () => void }>>([]);
	const workerReadyRef = useRef(false);

	const disposeProviders = useCallback(() => {
		for (const disposable of providerDisposables.current) {
			disposable.dispose();
		}
		providerDisposables.current = [];
	}, []);

	type WorkerRequestType =
		| "initialize"
		| "analyze"
		| "completion"
		| "hover"
		| "definition";

	interface WorkerResponseBase {
		type:
			| WorkerRequestType
			| "analysis"
			| "completion"
			| "hover"
			| "definition"
			| "initialized";
		requestId?: string;
	}

	interface WorkerInitialized extends WorkerResponseBase {
		type: "initialized";
		success: boolean;
		error?: string;
	}

	interface WorkerAnalysis extends WorkerResponseBase {
		type: "analysis";
		data: { diagnostics: WorkerDiagnostic[] };
	}

	interface WorkerCompletionItem {
		name: string;
		type: string;
		description: string;
		signature: string;
		docstring: string;
		insert_text: string;
	}

	interface WorkerCompletion extends WorkerResponseBase {
		type: "completion";
		data: WorkerCompletionItem[];
	}

	interface WorkerHover extends WorkerResponseBase {
		type: "hover";
		data: {
			contents: {
				kind: string;
				value: string;
			};
		} | null;
	}

	type WorkerResponse =
		| WorkerInitialized
		| WorkerAnalysis
		| WorkerCompletion
		| WorkerHover;

	interface WorkerDiagnostic {
		line: number;
		column: number;
		message: string;
		severity: "error" | "warning";
	}

	const callWorker = useCallback(
		async (
			type: WorkerRequestType,
			payload: Record<string, unknown> = {},
		): Promise<WorkerResponse | null> => {
			const worker = workerRef.current;
			if (!worker) {
				return null;
			}

			requestIdCounter.current += 1;
			const requestId = `${type}-${Date.now()}-${requestIdCounter.current}`;

			return new Promise((resolve) => {
				const timeoutId = window.setTimeout(() => {
					if (pendingRequests.current.has(requestId)) {
						pendingRequests.current.delete(requestId);
						resolve(null);
					}
				}, 5000);

				pendingRequests.current.set(requestId, (response) => {
					window.clearTimeout(timeoutId);
					resolve(response);
				});

				worker.postMessage({
					type,
					data: payload,
					requestId,
				});
			});
		},
		[],
	);

	useEffect(() => {
		if (language !== "python") {
			disposeProviders();
			return;
		}

		const worker = new PyrightWorker();
		workerRef.current = worker;

		worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			const message = event.data;
			if (message.requestId) {
				const resolver = pendingRequests.current.get(message.requestId);
				if (resolver) {
					pendingRequests.current.delete(message.requestId);
					resolver(message);
				}
			}
			if (message.type === "initialized" && "success" in message) {
				setIsWorkerReady(message.success);
				if (!message.success && "error" in message && message.error) {
					console.error("Jedi worker initialization failed:", message.error);
				}
			}
		};

		callWorker("initialize").catch((error) => {
			console.error("Failed to initialize worker:", error);
		});

		return () => {
			pendingRequests.current.clear();
			setIsWorkerReady(false);
			disposeProviders();
			worker.terminate();
			workerRef.current = null;
		};
	}, [callWorker, disposeProviders, language]);

	useEffect(() => {
		workerReadyRef.current = isWorkerReady;
	}, [isWorkerReady]);

	const updateDiagnostics = useCallback((diagnostics: WorkerDiagnostic[]) => {
		const monacoApi = monacoRef.current;
		const editorInstance = editorRef.current;
		if (!monacoApi || !editorInstance) {
			return;
		}

		const model = editorInstance.getModel();
		if (!model) {
			return;
		}

		const markers = diagnostics.map(({ line, column, message, severity }) => ({
			severity:
				severity === "error"
					? monacoApi.MarkerSeverity.Error
					: monacoApi.MarkerSeverity.Warning,
			startLineNumber: line,
			startColumn: column,
			endLineNumber: line,
			endColumn: column + 1,
			message,
		}));

		monacoApi.editor.setModelMarkers(model, "python-jedi", markers);
	}, []);

	const registerProviders = useCallback(
		(monacoApi: typeof import("monaco-editor")) => {
			disposeProviders();

			const completionDisposable =
				monacoApi.languages.registerCompletionItemProvider("python", {
					triggerCharacters: [".", "(", "["],
					provideCompletionItems: async (model, position) => {
						if (!workerReadyRef.current) {
							return { suggestions: [] };
						}

						const response = (await callWorker("completion", {
							code: model.getValue(),
							line: position.lineNumber,
							column: position.column - 1,
						})) as WorkerCompletion | null;

						if (!response || response.type !== "completion") {
							return { suggestions: [] };
						}

						const wordInfo = model.getWordUntilPosition(position);
						const range = new monacoApi.Range(
							position.lineNumber,
							wordInfo.startColumn,
							position.lineNumber,
							position.column,
						);

						const suggestions = response.data.map((item) => {
							const kind = (() => {
								switch (item.type) {
									case "function":
									case "method":
										return monacoApi.languages.CompletionItemKind.Function;
									case "class":
										return monacoApi.languages.CompletionItemKind.Class;
									case "module":
										return monacoApi.languages.CompletionItemKind.Module;
									case "instance":
										return monacoApi.languages.CompletionItemKind.Field;
									case "param":
									case "property":
										return monacoApi.languages.CompletionItemKind.Property;
									case "keyword":
									case "statement":
										return monacoApi.languages.CompletionItemKind.Keyword;
									default:
										return monacoApi.languages.CompletionItemKind.Text;
								}
							})();

							return {
								label: item.name,
								kind,
								detail: item.signature || item.description,
								documentation: item.docstring
									? { value: item.docstring }
									: undefined,
								insertText: item.name,
								filterText: item.name,
								range,
							};
						});

						return { suggestions };
					},
				});

			const hoverDisposable = monacoApi.languages.registerHoverProvider(
				"python",
				{
					provideHover: async (model, position) => {
						if (!workerReadyRef.current) {
							return null;
						}

						const response = (await callWorker("hover", {
							code: model.getValue(),
							line: position.lineNumber,
							column: position.column - 1,
						})) as WorkerHover | null;

						if (!response || response.type !== "hover") {
							return null;
						}

						if (!response.data) {
							return null;
						}

						const markdown = {
							value: response.data.contents.value,
							isTrusted: false,
						} as import("monaco-editor").IMarkdownString;

						return {
							contents: [markdown],
						};
					},
				},
			);

			providerDisposables.current = [completionDisposable, hoverDisposable];
		},
		[callWorker, disposeProviders],
	);

	function handleEditorDidMount(
		editor: editor.IStandaloneCodeEditor,
		monaco: typeof import("monaco-editor"),
	) {
		editorRef.current = editor;
		monacoRef.current = monaco;

		if (language === "python") {
			registerProviders(monaco);
		}
	}

	function handleEditorChange(value: string | undefined) {
		if (onChange) {
			onChange(value);
		}

		// コード変更時に解析を実行
		if (isWorkerReady && value) {
			callWorker("analyze", { code: value }).then((response) => {
				if (response && response.type === "analysis") {
					updateDiagnostics(response.data.diagnostics);
				}
			});
		}
	}

	return (
		<div className={className}>
			<Editor
				height={height}
				language={language}
				theme={theme}
				value={value}
				onChange={handleEditorChange}
				onMount={handleEditorDidMount}
				options={{
					readOnly,
					fontSize: 14,
					minimap: { enabled: false },
					scrollBeyondLastLine: false,
					wordWrap: "on",
					automaticLayout: true,
					tabSize: 4,
					insertSpaces: true,
					suggestOnTriggerCharacters: true,
					quickSuggestions: {
						other: true,
						comments: false,
						strings: true,
					},
					parameterHints: {
						enabled: true,
					},
					acceptSuggestionOnCommitCharacter: true,
					acceptSuggestionOnEnter: "on",
					tabCompletion: "on",
					formatOnPaste: true,
					formatOnType: true,
				}}
			/>
		</div>
	);
}
