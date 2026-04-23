// Here is an explanation of the overall architecture involving Pyodide, our Strype libraries and so on:
//
// Pyodide runs in a web worker, which is like a separate thread.  This file, python-execution.ts is the web worker code.
// The functions are exposed near the bottom using Comlink.expose.  The main function is executePython.  The only
// communication methods between web workers and the main thread are message channels.  Comlink is a Google-originating
// library that allows it to look like you are calling a web worker method from the main thread in a fairly normal way,
// and Comlink routes the parameters via the message channels.  It also lets you pass callbacks so that the webworker
// can call back into the main thread and again this is done underneath via message channels.
//
// There are two key things to know about data and web workers in Javascript:
//
// 1. Any objects (things like OffscreenCanvas) can only live on one thread, so you can't share data directly.  This is
//    both good (removes any possibility of simultaneous modification) and bad (you have to think carefully about where
//    data lives and how to share any changes).
//
// 2. The communication between the threads using Comlink (especially in conjunction with other libraries we'll come to)
//    can only use "plain" data: numbers, booleans, strings, and combinations thereof (arrays, or objects containing
//    only plain data).
//
// The other things to know are around sync/async, Pyodide and communication:
//
// - All underlying messages are sent asynchronously (i.e. without waiting for reply).  This means that all function
//   calls from Comlink have a Promise<..> return value, and if you want to wait for a return you'd need to "await"
//   or use .then().
//
// - When Pyodide calls a Javascript function (e.g. for reading stdin, or getting an Actor's position or asking which
//   keys are pressed), it is done in a normal (NOT async) call.  So you have a problem that you can't talk to the main
//   thread via messages/Comlink to get a message because you can't await the Promise-d answer.  It also means that
//   Pyodide code cannot do anything that needs async functions (e.g. certain image drawing operations).
//
// - As a work-around you can use a service worker (a different thing than a web worker, intended to be long lived).
//   So we have a service worker, which is just there to route messages around.  So you should never need to modify it.
//   This is all wrapped up into packages sync-message (which relay messages via the service worker) and comsync (which
//   combines sync-message with Comlink).
//
// - This synchronous messaging via the service worker is *expensive* in terms of time.  Firefox seems a bit slower than
//   Chrome, and on Firefox it can take 1-2 milliseconds per call.  If you are trying to run at say 30 frames per second,
//   you only have around 33 milliseconds per animation frame, so even 10 such calls can take up most of your time.
//
// So, we have two main constraints when designing our architecture: we need to message between the web worker and main
// thread using only plain data, and we need to try to minimise the amount of synchronous calls.  We need:
//  - the Pyodide thread to run the Python code (which will make Actors, move them around etc), and
//  - the main thread to draw the canvas (it's possible Pyodide could using an OffscreenCanvas, but if the main thread
//    does it then it can be done at any time regardless of what Pyodide is doing, and takes CPU cycles off the Pyodide
//    thread, which will be the busier thread while running Python flat out), and to listen for key events and mouse
//    clicks.  Plus, the main thread has to be responsible for any async code that Pyodide thread is not allowed to run.
//
// The solution is in the file worker_bridge_type.ts which has a protocol (with explanatory comment) for communicating
// between the threads.  There are "Sync" messages which need a reply, but where possible we use "Async messages" that
// can be fired off without needing a reply, as this is faster.
//
// There are several concepts that are split up:
//  - Actors are Python-only objects in Pyodide.  No Javascript function ever directly interacts with an Actor.
//  - Sprites are things with a position, rotation, image etc.  They are effectively the Javascript version of an Actor
//    but the mapping is not one-to-one.  Notably: the background is a Sprite but has no Actor, and say() bubbles on
//    actors are Sprites but also have no Actor.  Sprites are referred to from Python via an integer handle that maps
//    to an array/Map held in Javascript.  So only integers are passed between Python and Javascript to refer to sprites,
//    never the actual Sprite (or Actor) objects.
//  - Each Sprite's image can either be an ImageBitmap or OffscreenCanvas.  We generally prefer ImageBitmap if the image
//    is not modified because it uses less resources.  But if the user edits the image (via Image class in Strype) then
//    it needs to become OffscreenCanvas.  So we must allow for either possibility at most points.
//
// In terms of splitting up the data and so on:
// - The web worker is primarily responsible for tracking Actor state (via Actors in Python) and sprite state (via
//   SpriteManager in Javascript).  It mirrors the SpriteManager state to the main thread via a dedicated async message
//   channel.
// - All the actual images and canvases are held on the main thread for fast communication-free rendering there.  All
//   manipulations of the image requested by Python code must be sent to the main thread.  Manipulations are usually
//   "Async" (see above) so fast, but queries (mainly: what colour is this pixel) are "Sync" meaning they need a reply
//   and are slow.

// Tell Typescript we are on a web worker, so we can access web worker bits but not the DOM:
/// <reference lib="webworker" />
import type { PyodideInterface } from "pyodide";
import { loadPyodide } from "pyodide";
import { loadPyodideAndPackage, makeRunnerCallback, OutputPart, pyodideExpose, PyodideExtras, PyodideFatalErrorReloader } from "pyodide-worker-runner";
import * as Comlink from "comlink";
import { strype_bridge } from "@/stryperuntime/pyodide_bridge";
import { ResponseFor, SyncOrAsyncStrypePyodideWorkerRequest, SyncStrypePyodideHandlerFunction, SyncStrypePyodideWorkerRequest, SyncStrypePyodideWorkerResponse } from "@/stryperuntime/worker_bridge_type";
import { SpriteManager } from "@/stryperuntime/image_and_collisions";
import { PyodideWorkerGlobalScope } from "@/workers/python_execution_type";
import {getFSForEmscripten} from "@/stryperuntime/pyodide-emscripten-cloud-fs";
import {createLazyFetchAssetsFS} from "@/stryperuntime/pyodide-emscripten-assets-fs";

// We only specify updatePort here as we don't want other files using it directly:
declare const self: PyodideWorkerGlobalScope & { updatePort: MessagePort; currentPyodideScriptSource: string };

export async function serviceWorkerReadyAndInControl() : Promise<void> {
    await navigator.serviceWorker.ready;

    // If already controlled, all is fine:
    if (navigator.serviceWorker.controller) {
        return;
    }
    // Wait until the service worker takes control:
    await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
    });
}


async function loadOnly() : Promise<PyodideInterface> {
    const pyodide = await loadPyodideAndPackage({url: `${import.meta.env.BASE_URL}pysrc.zip`, format: "zip"}, loadPyodide);
    
    // Register our strype.graphics etc modules with Pyodide by pointing it to the Javascript:
    pyodide.registerJsModule("strype_bridge", strype_bridge);
    
    // Register our file system for cloud access.  We create it here to save time and to make
    // sure we only create it (and the dir /cloud) once, but since the user can save to a new location between
    // Pyodide initialising and Pyodide running, we always create the /cloud file system, but we dynamically decide
    // whether to mount and "cd /cloud" before running, and we give a runtime error if the user tries to access the file system
    // while not saved to the cloud.
    pyodide.FS.filesystems.CLOUDFS = getFSForEmscripten(pyodide);
    pyodide.FS.mkdir("/cloud");
    
    pyodide.FS.filesystems.ASSETSFS = createLazyFetchAssetsFS(pyodide);
    pyodide.FS.mkdir("/strype");
    
    return pyodide;
}
const reloader = new PyodideFatalErrorReloader(loadOnly);

export interface ErrorDetails {
    error_type: string,
    error_message: string,
    text: string,
    traceback: {filename: string, lineno: number}[]
}

const executePython = pyodideExpose(async (
    extras: PyodideExtras,
    pythonCode: string,
    debugMode: boolean,
    startInSlashCloud: boolean,
    printStdout: Comlink.Remote<(output: string) => void>,
    requestInput: Comlink.Remote<(prompt: string) => void>,
    // Important all requests (sync and async) go through one function to avoid them racing each other:
    otherRequest: Comlink.Remote<(req: SyncOrAsyncStrypePyodideWorkerRequest) => void>
) : Promise<ErrorDetails | null> => {
    return await reloader.withPyodide(async (pyodide : PyodideInterface) => {
        self.currentPyodideScriptSource = pythonCode;

        const bridgeSync: SyncStrypePyodideHandlerFunction = <R extends SyncStrypePyodideWorkerRequest> (req : R) : ResponseFor<R> => {
            otherRequest({kind: "sync", request: req});
            const reply = extras.readMessage() as (SyncStrypePyodideWorkerResponse | {request: string, error: string});
            if (reply.request != req.request) {
                throw new Error(`Internal error: Pyodide worker received ${reply.request} but had asked for ${req.request}`);
            }
            else if ("error" in reply) {
                // We propagate to the user so they get some feedback:
                throw (req.request.startsWith("file_") ? new pyodide.FS.ErrnoError(63, "Cloud file error:" + reply.error) : new Error("Internal error:" + reply.error));
            }
            else {
                // I think Typescript should be able to infer reply is ResponseFor<R> because of the if check, but apparently not:
                return reply as ResponseFor<R>;
            }
        }; 

        // Define the pause hook on the global scope SECOND, so Python can find it
        self.pauseForDebugger = (line: number, stateJson: string) => {
            bridgeSync({
                request: "debug_pause",
                line: line,
                state: stateJson,
            } as any); 
        };

        const runner = pyodide.runPython(`from python_runner import PyodideRunner
import ast
import traceback
import sys
import json
from itertools import dropwhile
from js import pauseForDebugger, currentPyodideScriptSource

def filter_variables(var_dict):
    clean_dict = {}
    for key, value in var_dict.items():
        if key.startswith('__'): continue
        if type(value).__name__ == 'module': continue
        if callable(value): continue
        clean_dict[key] = {
            "type": type(value).__name__,
            "value": repr(value)
        }
    return clean_dict

def get_call_stack(frame):
    stack_summary = traceback.extract_stack(frame)
    formatted_stack = []
    for item in stack_summary:
        is_user_code = "my_program.py" in item.filename or "<string>" in item.filename or "<stdin>" in item.filename
        if not is_user_code:
            continue
        formatted_stack.append({
            "file": item.filename,
            "line": item.lineno,
            "function": item.name if item.name != "<module>" else "My code",
            "code": item.line.strip() if item.line else ""
        })
    return formatted_stack

trace_started = False

def get_first_executable_line(source):
    try:
        module = ast.parse(source)
    except SyntaxError:
        return 1

    for node in module.body:
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if isinstance(node, ast.Expr) and isinstance(getattr(node, "value", None), ast.Constant) and isinstance(node.value.value, str):
            continue
        return node.lineno

    return 1

first_executable_line = get_first_executable_line(currentPyodideScriptSource)

def trace_lines(frame, event, arg):
    global trace_started
    filename = frame.f_code.co_filename
    
    # Only trace the user's actual script ---
    is_user_code = "my_program.py" in filename or "<string>" in filename or "<stdin>" in filename
    if not is_user_code:
        return trace_lines
    
    if event == 'line':
        current_method = frame.f_code.co_name

        # Skip module-level setup (including imports and initial declarations)
        # and start tracing from the first top-level executable line.
        if not trace_started:
            if current_method == "<module>" and frame.f_lineno < first_executable_line:
                return trace_lines
            trace_started = True

        if current_method == "<module>":
            current_method = "Global Scope"
        state = {
            "method": current_method,
            "globals": filter_variables(frame.f_globals),
            "locals": {} if current_method == "Global Scope" else filter_variables(frame.f_locals),
            "stack": get_call_stack(frame)
        }
        pauseForDebugger(frame.f_lineno, json.dumps(state))
    return trace_lines

class StrypePyodideRunner(PyodideRunner):
    def serialize_traceback(self, exc):
        tbe = traceback.TracebackException.from_exception(exc)
        filtered = [dict(filename=frame.filename, lineno=frame.lineno) for frame in list(dropwhile(lambda f: f.filename != self.filename, tbe.stack))]
        return dict(error_type=type(exc).__name__, error_message=str(exc), traceback=filtered, text=type(exc).__name__ + ": " + str(exc))

StrypePyodideRunner()`);

        // Set the global fields used by Javascript code (and by the pyodide cloud file mounting, just below): 
        self.syncStrypePyodideWorkerBridge = bridgeSync;
        self.asyncStrypePyodideWorkerBridge = (r) => otherRequest({kind: "async", request: r});
        self.spriteManager = new SpriteManager((u) => self.updatePort.postMessage(u));
        self.pyodide = pyodide;
        

        // If we are offering the cloud file system, we start there by default:
        if (startInSlashCloud) {
            // Try unmounting in case we're running a second time:
            try {
                pyodide.FS.unmount("/cloud");
            }
            catch {
                // Ignore any errors
            }
            try {
                // We have done the mkdir("/cloud") in the one time Pyodide initialisation, earlier.
                pyodide.FS.mount(pyodide.FS.filesystems.CLOUDFS, {}, "/cloud");
                pyodide.FS.chdir("/cloud");
            }
            catch (e) {
                console.error("Problem mounting cloud file system: ", e);
            }
        }
        pyodide.FS.mount(pyodide.FS.filesystems.ASSETSFS, {}, "/strype");
        
        let error : ErrorDetails | null = null;
        const callback = makeRunnerCallback(extras, {
            output: (outputText: OutputPart[]) => {
                const stdoutParts = outputText.filter((t) => t.type == "stdout");
                if (stdoutParts.length > 0) {
                    printStdout(stdoutParts.map((t) => t.text).join(""));
                }
                const errorParts = outputText.filter((t) => t.type == "traceback");
                if (errorParts.length == 1) {
                    // As per the Python above:
                    const details = errorParts[0] as unknown as ErrorDetails;
                    error = details;
                }
                else if (errorParts.length > 1) {
                    // I don't think this should happen, but log it in case:
                    console.error("Unexpected multiple error parts from one call: " + JSON.stringify(errorParts));
                }
            },
            // We fire off the input request and it asynchronously gives back the input by writing a message,
            // NOT by directly returning it:
            input: requestInput,
            other: (type: string, data: any) => {
                // This is for sleep events that we are not necessarily interested in
            },
        });
        runner.set_callback(callback);
        // Set the global fields used by Javascript code: 
        self.syncStrypePyodideWorkerBridge = bridgeSync;
        self.asyncStrypePyodideWorkerBridge = (r) => otherRequest({kind: "async", request: r});
        self.spriteManager = new SpriteManager((u) => self.updatePort.postMessage(u));
        self.pyodide = pyodide;

        // Set the trace if debugMode is true, then run
        if (debugMode) {
            pyodide.runPython("sys.settrace(trace_lines)");
        }

        await runner.run_async(pythonCode, {});

        // Remove the settrace, so debugMode is off for subsequent runs
        if (debugMode) {
            pyodide.runPython("sys.settrace(None)");
        }
        
        return error;
    });
});

const onReady = pyodideExpose(async (extras: PyodideExtras, callOnceReady:  Comlink.Remote<() => void>)=> {
    await reloader.withPyodide(async () => callOnceReady());
});

Comlink.expose({
    executePython,
    onReady,
});

// We receive one message early on with the updatePort which we must store in a global:
self.addEventListener("message", (e : any) => {
    if (e.data.updatePort) {
        self.updatePort = e.data.updatePort;
    }
});
