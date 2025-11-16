# Monaco Editor-based Python editor with IntelliSense

A simple web-based Python editor with IntelliSense (autocompletion) using the Monaco Editor, Pyodide, and Jedi.

- Pyodide - A WebAssembly-based runtime for executing Python in the browser
    - Loaded directly from a CDN (cdn.jsdelivr.net)
- Jedi - An autocompletion library for Python
    - Installed in the browser using micropip

All processing is completed **on the client side (within the browser)**

# How to run
```bash
npm install # Install dependencies
npm run dev # Start the development server
```

To build, use `npm run build` instead of `npm run dev`.  
The built files will be in the `dist` folder.
