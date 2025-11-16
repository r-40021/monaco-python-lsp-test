import { useState } from "react";
import MonacoEditor from "@/components/MonacoEditor";

const initialCode = `import numpy as np
import pandas as pd

def calculate_statistics(data: list[float]) -> dict:
    """Calculate basic statistics for a list of numbers."""
    arr = np.array(data)
    
    return {
        'mean': float(np.mean(arr)),
        'median': float(np.median(arr)),
        'std': float(np.std(arr)),
    }

# Example usage
data = [1.0, 2.5, 3.7, 4.2, 5.9, 6.1, 7.3, 8.0]
result = calculate_statistics(data)
print(result)
`;

export default function Home() {
	const [code, setCode] = useState(initialCode);

	return (
		<main className="min-h-screen p-4">
			<div className="max-w-7xl mx-auto">
				<h1 className="text-2xl font-bold mb-4">
					Monaco Editor - Python
				</h1>
				<a href="pure.html" className="text-blue-500 underline mb-4 inline-block">
						Switch to Pure Monaco Editor (no IntelliSense)
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
