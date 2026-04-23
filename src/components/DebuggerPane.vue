<template>
    <div class="debugger-mode-container">
        <div class="debugger-header">
            <SVGIcon name="PEA-layout-split-expanded" :customClass="'debugger-icon'"/>
            <span>Debugger Pane</span>
        </div>

        <div class="debugger-content">
            <div class="debugger-left-pane">
                <div class="debugger-section">
                    <h4 class="debugger-section-title">Call Stack</h4>
                    <div class="debugger-list">
                        <div v-if="!debuggerState?.stack || debuggerState.stack.length === 0" class="empty-state">No active stack</div>
                        <div v-for="(frame, index) in reversedStack" :key="'stack'+index" class="debugger-item stack-item">
                            <span class="step-indicator" v-if="index === 0">-></span>
                            <span class="step-indicator" v-else>&nbsp;&nbsp;&nbsp;</span>
                            <span class="frame-func">{{ frame.function }}</span> 
                        </div>
                    </div>
                </div>
            </div>

            <div class="debugger-right-pane">
                <div class="debugger-section">
                    <h4 class="debugger-section-title">
                        Locals <span v-if="debuggerState?.method && debuggerState.method !== 'Global Scope'" class="method-context">({{ debuggerState.method }})</span>
                    </h4>
                    <div class="debugger-list">
                        <div v-if="!debuggerState?.locals || Object.keys(debuggerState.locals).length === 0" class="empty-state">No local variables</div>
                        <div v-for="(val, key) in debuggerState?.locals" :key="'loc'+key" class="debugger-item">
                            <span class="var-name">{{ key }}</span>:
                            <span class="var-value" :class="getVarTypeClass(val)">{{ getVarValue(val) }}</span>
                            <span class="var-type-pill" :class="getVarTypeClass(val)">{{ getVarType(val) }}</span>
                        </div>
                    </div>
                </div>

                <div class="debugger-section">
                    <h4 class="debugger-section-title">Globals</h4>
                    <div class="debugger-list">
                        <div v-if="!debuggerState?.globals || Object.keys(debuggerState.globals).length === 0" class="empty-state">No global variables</div>
                        <div v-for="(val, key) in debuggerState?.globals" :key="'glob'+key" class="debugger-item">
                            <span class="var-name">{{ key }}</span>:
                            <span class="var-value" :class="getVarTypeClass(val)">{{ getVarValue(val) }}</span>
                            <span class="var-type-pill" :class="getVarTypeClass(val)">{{ getVarType(val) }}</span>
                        </div>
                    </div>
                </div>
            </div>

        </div>
    </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import SVGIcon from "@/components/SVGIcon.vue";
import { mapStores } from "pinia";
import { useStore } from "@/store/store";

export default defineComponent({
    name: "DebuggerPane",
    components: {
        SVGIcon,
    },
    computed: {
        ...mapStores(useStore),
        debuggerState(): any {
            return this.appStore.currentDebuggerState;
        },
        reversedStack() {
            if (!(this.appStore.currentDebuggerState?.stack)) {
                return [];
            }

            return [...this.appStore.currentDebuggerState?.stack].reverse(); 
        },
    },
    methods: {
        getVarType(variable: any): string {
            if (typeof variable === "string") {
                return "unknown";
            }
            return variable.type || "unknown";
        },
        getVarValue(variable: any): string {
            if (typeof variable === "string") {
                return variable;
            }
            return variable.value;
        },
        getVarTypeClass(variable: any): string {
            const pythonType = this.getVarType(variable);
            return `var-type-${pythonType.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()}`;
        },
    },
});
</script>

<style lang="scss">
.debugger-mode-container {
    padding: 10px 15px;
    background-color: #E2E7E0;
    height: 100%;
    width: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.debugger-header {
    display: flex;
    align-items: center;
    color: #274D19;
    font-weight: 700;
    font-size: 1.1em;
    margin-bottom: 10px;
    border-bottom: 2px solid #bbc8b6;
    padding-bottom: 5px;
    flex-shrink: 0; 
}

.debugger-icon {
    width: 20px;
    height: 20px;
    margin-right: 8px;
    color: #274D19;
}

.debugger-content {
    display: flex;
    flex-direction: row;
    gap: 15px;
    flex: 1; 
    overflow: hidden; 
}

.debugger-left-pane,
.debugger-right-pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding-right: 5px;
}

.debugger-right-pane {
    flex: 1.2; 
}

.debugger-section {
    margin-bottom: 20px;
}

.debugger-section-title {
    font-size: 0.9em;
    font-weight: 600;
    color: #4a5c44;
    text-transform: uppercase;
    margin-bottom: 8px;
    letter-spacing: 0.5px;
    position: sticky;
    top: 0;
    background-color: #E2E7E0;
    z-index: 2;
}

.method-context {
    text-transform: none;
    font-style: italic;
    color: #787978;
}

.debugger-list {
    background: #ffffff;
    border: 1px solid #bbc8b6;
    border-radius: 6px;
    padding: 8px;
    font-size: 0.9em;
    box-shadow: inset 0 1px 3px rgba(0,0,0,0.05);
}

.debugger-item {
    padding: 4px 0;
    border-bottom: 1px solid #f0f0f0;
    word-break: break-all;
}

.var-type-pill {
    display: inline-block;
    margin-left: 8px;
    padding: 1px 6px;
    border-radius: 10px;
    font-size: 0.75em;
    font-weight: 600;
    border: 1px solid transparent;
    vertical-align: middle;
}

.debugger-item:last-child {
    border-bottom: none;
}

.stack-item {
    display: flex;
    align-items: baseline;
}

.step-indicator {
    margin-right: 8px;
    font-size: 1.1em;
}

.frame-func {
    font-weight: bold;
    color: #0221a8;
    margin-right: 8px;
}

.frame-line {
    color: #787978;
    font-size: 0.9em;
    white-space: nowrap;
}

.var-name {
    font-weight: bold;
    color: #a80202;
}

.var-value {
    color: #000000;
}

.var-type-int,
.var-type-bool {
    color: #8d2a13;
}

.var-type-float,
.var-type-complex {
    color: #7a3e00;
}

.var-type-str,
.var-type-bytes {
    color: #0d5f20;
}

.var-type-list,
.var-type-tuple,
.var-type-range {
    color: #115c73;
}

.var-type-dict,
.var-type-set,
.var-type-frozenset {
    color: #21509b;
}

.var-type-nonetype {
    color: #6f6f6f;
}

.var-type-unknown {
    color: #444444;
}

.var-type-pill.var-type-int,
.var-type-pill.var-type-bool {
    background: #fff2ef;
    border-color: #f3c6bf;
}

.var-type-pill.var-type-float,
.var-type-pill.var-type-complex {
    background: #fff6ec;
    border-color: #f0d4ae;
}

.var-type-pill.var-type-str,
.var-type-pill.var-type-bytes {
    background: #eef9f1;
    border-color: #b9dec2;
}

.var-type-pill.var-type-list,
.var-type-pill.var-type-tuple,
.var-type-pill.var-type-range {
    background: #eef8fb;
    border-color: #b9d9e3;
}

.var-type-pill.var-type-dict,
.var-type-pill.var-type-set,
.var-type-pill.var-type-frozenset {
    background: #eef3ff;
    border-color: #bccaf0;
}

.var-type-pill.var-type-nonetype,
.var-type-pill.var-type-unknown {
    background: #f4f4f4;
    border-color: #d7d7d7;
}

.empty-state {
    color: #a0a0a0;
    font-style: italic;
    padding: 4px 0;
}

.debugger-left-pane::-webkit-scrollbar,
.debugger-right-pane::-webkit-scrollbar {
    width: 6px;
}
.debugger-left-pane::-webkit-scrollbar-track,
.debugger-right-pane::-webkit-scrollbar-track {
    background: transparent;
}
.debugger-left-pane::-webkit-scrollbar-thumb,
.debugger-right-pane::-webkit-scrollbar-thumb {
    background: #bbc8b6;
    border-radius: 4px;
}
</style>