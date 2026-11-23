import { Plugin } from "@opencode/plugin";
import { setupConductorPlugin } from "./host/plugin.js";

export default Plugin.define({
    id: "opencode-conductor",
    setup: setupConductorPlugin,
});
