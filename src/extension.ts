import * as vscode from "vscode";

import { SecretDebugAdapterTrackerFactory } from "./debugAdapterProxy";

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterTrackerFactory(
            "*",
            new SecretDebugAdapterTrackerFactory(),
        ),
    );
}
