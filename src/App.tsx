import { useState } from "react";
import MonacoEditor from "@/components/MonacoEditor";

const initialCode = `import banana


class Monkey:
    # Bananas the monkey can eat.
    capacity = 10
    def eat(self, n):
        """Make the monkey eat n bananas!"""
        self.capacity -= n * banana.size

    def feeding_frenzy(self):
        self.eat(9.25)
        return "Yum yum"
`;

export default function Home() {
	const [code, setCode] = useState(initialCode);

	return (
		<main className="min-h-screen p-4">
			<div className="max-w-7xl mx-auto">
				<h1 className="text-2xl font-bold mb-4">
					Monaco Editor - Python
				</h1>
				<a href="https://microsoft.github.io/monaco-editor/" className="text-blue-500 underline mb-4 inline-block" target="_blank" rel="noopener noreferrer">
						Official demo site of Monaco Editor (no IntelliSense for Python)
				</a>

				<MonacoEditor
					value={code}
					onChange={(value) => setCode(value || "")}
					language="python"
					theme="vs-dark"
					height="calc(100vh - 120px)"
					className="border border-gray-700 rounded-lg overflow-hidden"
				/>
			</div>
		</main>
	);
}
