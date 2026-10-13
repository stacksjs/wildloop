(() => {
  // node_modules/@stacksjs/stx/dist/native/runtime/jsc-globals.js
  class NativeEvent {
    type;
    detail;
    target = null;
    key = "";
    ctrlKey = false;
    altKey = false;
    shiftKey = false;
    metaKey = false;
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
    preventDefault() {}
    stopPropagation() {}
  }
  function installJSCGlobals(target = globalThis) {
    const listeners = new Map, addEventListener2 = (name, listener) => {
      const group = listeners.get(name) ?? new Set;
      group.add(listener);
      listeners.set(name, group);
    }, removeEventListener = (name, listener) => {
      listeners.get(name)?.delete(listener);
    }, dispatchEvent = (event) => {
      for (const listener of listeners.get(event.type) ?? [])
        listener(event);
      return true;
    }, emptyList = [], documentElement = { setAttribute() {}, removeAttribute() {}, getAttribute() {
      return null;
    } }, head = { appendChild() {} };
    target.window = target;
    target.Node ??= { ELEMENT_NODE: 1, TEXT_NODE: 3, COMMENT_NODE: 8 };
    target.Event ??= NativeEvent;
    target.CustomEvent ??= NativeEvent;
    target.addEventListener ??= addEventListener2;
    target.removeEventListener ??= removeEventListener;
    target.dispatchEvent ??= dispatchEvent;
    target.performance ??= { now: () => Date.now() };
    target.queueMicrotask ??= (callback) => Promise.resolve().then(callback);
    target.requestAnimationFrame ??= (callback) => target.setTimeout(() => callback(Date.now()), 0);
    target.cancelAnimationFrame ??= (id) => target.clearTimeout(id);
    target.location ??= { href: "", pathname: "/", search: "", hash: "" };
    target.history ??= { back() {}, forward() {}, pushState() {}, replaceState() {} };
    target.navigator ??= { language: "en" };
    target.document ??= {
      body: null,
      head,
      hidden: false,
      documentElement,
      addEventListener: addEventListener2,
      removeEventListener,
      dispatchEvent,
      querySelectorAll: () => emptyList,
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({
        setAttribute() {},
        removeAttribute() {},
        appendChild() {},
        style: {},
        textContent: ""
      })
    };
  }

  // node_modules/@stacksjs/stx/dist/native/bridge/protocol.js
  class NativeCapabilityError extends Error {
    code;
    constructor(code, message) {
      super(message);
      this.code = code;
      this.name = "NativeCapabilityError";
    }
  }

  class STXBridge {
    messageId = 0;
    handlers = new Map;
    pendingRequests = new Map;
    nativeBridge = null;
    defaultTimeout = 30000;
    initialize(nativeBridge) {
      this.nativeBridge = nativeBridge;
      const timeout = Number(nativeBridge.capabilityTimeoutMs);
      if (Number.isFinite(timeout) && timeout > 0)
        this.defaultTimeout = timeout;
      nativeBridge.onMessage((rawMessage) => {
        try {
          const message = JSON.parse(rawMessage);
          this.handleIncomingMessage(message);
        } catch (error) {
          console.error("[STXBridge] Failed to parse message:", error);
        }
      });
    }
    send(type, payload) {
      const message = this.createMessage(type, payload);
      this.postToNative(message);
      return message.id;
    }
    async request(type, payload, timeout = this.defaultTimeout) {
      const message = this.createMessage(type, payload);
      return new Promise((resolve, reject) => {
        const scheduleTimeout = typeof globalThis.setTimeout === "function" ? globalThis.setTimeout.bind(globalThis) : null, timeoutId = scheduleTimeout ? scheduleTimeout(() => {
          this.pendingRequests.delete(message.id);
          if (type === "API_REQUEST")
            this.postToNative(this.createMessage("API_CANCEL", {
              version: 1,
              requestId: message.id,
              reason: "timeout"
            }));
          reject(new NativeCapabilityError("TIMEOUT", `Request ${message.id} timed out after ${timeout}ms`));
        }, timeout) : null;
        this.pendingRequests.set(message.id, {
          resolve,
          reject,
          timeout: timeoutId
        });
        this.postToNative(message);
      });
    }
    on(type, handler) {
      if (!this.handlers.has(type))
        this.handlers.set(type, new Set);
      this.handlers.get(type).add(handler);
      return () => {
        this.handlers.get(type)?.delete(handler);
      };
    }
    once(type, handler) {
      const wrappedHandler = (message) => {
        unsubscribe();
        handler(message);
      }, unsubscribe = this.on(type, wrappedHandler);
      return unsubscribe;
    }
    dispose(reason = "screen-closed") {
      for (const [requestId, pending] of this.pendingRequests) {
        if (pending.timeout !== null && typeof globalThis.clearTimeout === "function")
          globalThis.clearTimeout(pending.timeout);
        this.postToNative(this.createMessage("API_CANCEL", {
          version: 1,
          requestId,
          reason
        }));
        pending.reject(new NativeCapabilityError("CANCELLED", `Request ${requestId} was cancelled because the native screen closed`));
      }
      this.pendingRequests.clear();
      this.handlers.clear();
      this.nativeBridge = null;
    }
    render(document2, options = {}) {
      return this.send("RENDER", {
        document: document2,
        containerId: options.containerId,
        mode: options.mode || "replace"
      });
    }
    mutate(payload) {
      return this.send("MUTATE", payload);
    }
    update(updates) {
      return this.send("UPDATE", { updates });
    }
    remove(keys) {
      return this.send("REMOVE", { keys });
    }
    navigate(screen, params, animation) {
      return this.send("NAVIGATE", { screen, params, animation });
    }
    goBack() {
      return this.send("NAVIGATE_BACK", {});
    }
    async callNativeAPI(module, method, ...args) {
      return this.request("API_REQUEST", {
        version: 1,
        module,
        method,
        args
      });
    }
    log(level, message, data) {
      this.send("DEBUG_LOG", { level, message, data });
    }
    createMessage(type, payload) {
      return {
        id: `js_${++this.messageId}_${Date.now()}`,
        type,
        timestamp: Date.now(),
        payload,
        source: "js"
      };
    }
    postToNative(message) {
      if (!this.nativeBridge) {
        console.error("[STXBridge] Native bridge not initialized");
        return;
      }
      try {
        this.nativeBridge.postMessage(JSON.stringify(message));
      } catch (error) {
        console.error("[STXBridge] Failed to post message:", error);
      }
    }
    handleIncomingMessage(message) {
      if (message.correlationId && this.pendingRequests.has(message.correlationId)) {
        const pending = this.pendingRequests.get(message.correlationId);
        this.pendingRequests.delete(message.correlationId);
        if (pending.timeout !== null && typeof globalThis.clearTimeout === "function")
          globalThis.clearTimeout(pending.timeout);
        if (message.type === "API_ERROR") {
          const error = message.payload;
          pending.reject(new NativeCapabilityError(error.code, error.message));
        } else
          pending.resolve(message.payload.data);
        return;
      }
      const handlers = this.handlers.get(message.type);
      if (handlers)
        for (const handler of handlers)
          try {
            handler(message);
          } catch (error) {
            console.error(`[STXBridge] Handler error for ${message.type}:`, error);
          }
    }
  }

  // node_modules/@stacksjs/stx/dist/native/runtime/binding-tree.js
  function decodeBindingValue(value) {
    return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'").replace(/&amp;/g, "&");
  }
  function createBindingNode(id, type, bindings, connected = true, classes = "", onClassChange) {
    const attributes = bindings.map((binding) => ({
      name: binding.name,
      value: decodeBindingValue(binding.value)
    }));
    if (classes && !attributes.some((attribute) => attribute.name === "class"))
      attributes.push({ name: "class", value: classes });
    const node = {
      __stxId: id,
      nodeType: 1,
      get className() {
        return node.getAttribute("class") ?? "";
      },
      set className(value) {
        node.setAttribute("class", value);
      },
      classList: {
        add(...tokens) {
          node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...tokens])].join(" ");
        },
        remove(...tokens) {
          node.className = node.className.split(/\s+/).filter((token) => token && !tokens.includes(token)).join(" ");
        }
      },
      tagName: type.toUpperCase(),
      attributes,
      parentNode: null,
      parentElement: null,
      childNodes: [],
      children: [],
      nextSibling: null,
      nextElementSibling: null,
      namespaceURI: "",
      isConnected: true,
      hasAttribute(name) {
        return attributes.some((attribute) => attribute.name === name);
      },
      getAttribute(name) {
        return attributes.find((attribute) => attribute.name === name)?.value ?? null;
      },
      setAttribute(name, value) {
        const existing = attributes.find((attribute) => attribute.name === name);
        if (existing)
          existing.value = String(value);
        else
          attributes.push({ name, value: String(value) });
        if (name === "class")
          onClassChange?.(String(value));
      },
      removeAttribute(name) {
        const index = attributes.findIndex((attribute) => attribute.name === name);
        if (index !== -1)
          attributes.splice(index, 1);
        if (name === "class")
          onClassChange?.("");
      },
      contains(candidate) {
        for (let current = candidate;current; current = current.parentNode)
          if (current === node)
            return true;
        return false;
      },
      querySelector(selector) {
        return node.querySelectorAll(selector)[0] ?? null;
      },
      querySelectorAll(selector) {
        const found = [], attribute = /^\[([^\]]+)\]$/.exec(selector)?.[1], visit = (candidate) => {
          const element = candidate;
          if (element.nodeType === 1) {
            if (selector === "*" || attribute && element.hasAttribute(attribute))
              found.push(element);
            element.childNodes.forEach(visit);
          }
        };
        node.childNodes.forEach(visit);
        return found;
      }
    };
    node.isConnected = connected;
    return node;
  }
  function cloneNativeBindingNode(source, id, onClassChange) {
    const bindings = source.attributes.map((attribute) => ({
      name: attribute.name,
      value: attribute.value,
      kind: "attr"
    }));
    return createBindingNode(id, source.tagName, bindings, false, source.className, onClassChange);
  }
  function materializeNativeBindingTree(document2, manifest, host) {
    const entries = new Map(manifest.entries.map((entry) => [entry.id, entry])), nodes = new Map;
    let sequence = 0;
    function visit(source, parent) {
      const id = `n${sequence++}`, runtimeBindings = [...(source.bindingId === undefined ? undefined : entries.get(source.bindingId))?.bindings ?? []];
      for (const [name, value] of Object.entries(source.bindings ?? {}))
        if (!runtimeBindings.some((binding) => binding.name.replace(/^[:@]/, "") === name))
          runtimeBindings.push({ name: `:${name}`, value, kind: "attr" });
      const node = createBindingNode(id, source.type, runtimeBindings, true, source._classes, (value) => host.setAttribute(node, "class", value));
      source.id = id;
      source.props.__stxId = id;
      node.parentNode = parent;
      node.parentElement = parent;
      host.adopt(node, source.type, parent, source);
      if (source.bindingId !== undefined) {
        node.setAttribute("data-stx-b", source.bindingId);
        nodes.set(source.bindingId, node);
      }
      for (const child of source.children) {
        if (typeof child === "string")
          continue;
        const childNode = visit(child, node);
        node.childNodes.push(childNode);
        node.children.push(childNode);
      }
      return node;
    }
    return { root: visit(document2.root, null), nodes };
  }

  // node_modules/@stacksjs/stx/dist/native/runtime/craft-bridge.js
  function capabilityFlags(capabilities) {
    return {
      haptics: capabilities.has("haptics"),
      speechRecognition: false,
      share: false,
      camera: false,
      biometric: capabilities.has("biometric"),
      pushNotifications: false,
      secureStorage: capabilities.has("secureStorage"),
      storage: capabilities.has("storage"),
      localDatabase: capabilities.has("database"),
      lifecycle: capabilities.has("lifecycle"),
      geolocation: false,
      clipboard: capabilities.has("clipboard"),
      contacts: false,
      calendar: false,
      localNotifications: capabilities.has("notifications"),
      inAppPurchase: false,
      keepAwake: false,
      orientationLock: false,
      deepLinks: capabilities.has("deepLinks"),
      flashlight: false,
      speech: false,
      network: false,
      deviceInfo: capabilities.has("device"),
      fetch: capabilities.has("fetch"),
      badge: false,
      appReview: false
    };
  }
  function installCraftBridge(protocol, nativeBridge, target = globalThis, options = {}) {
    const craft = target.craft = target.craft || {}, capabilities = new Set(nativeBridge.capabilities || []), request = (module, method, args) => protocol.callNativeAPI(module, method, ...args);
    let appState = nativeBridge.initialAppState || "active", initialDeepLinkClaimed = false;
    const appStateHandlers = new Set, deepLinkHandlers = new Set, navButtonHandlers = new Set, navButtonPresses = new Map, routeName = options.routeName || "main", routeNames = options.routeNames || [routeName];
    craft.platform = nativeBridge.platform || "unknown";
    craft.capabilityProtocolVersion = Number(nativeBridge.capabilityProtocolVersion || 0);
    craft.capabilities = capabilityFlags(capabilities);
    craft.route = { name: routeName, params: target.__stxNativeParams || {} };
    craft.appearance = { colorScheme: () => nativeBridge.colorScheme === "dark" ? "dark" : "light" };
    craft.device = { getInfo: () => request("Device", "getInfo", []) };
    craft.clipboard = {
      write: (value) => request("Clipboard", "write", [value]),
      read: () => request("Clipboard", "read", [])
    };
    craft.haptic = (style) => request("Haptics", "impact", [style || "medium"]);
    const feedback = (answer) => answer.then(() => {}, (error) => {
      if (error?.code === "CAPABILITY_DISABLED")
        return;
      throw error;
    });
    craft.haptics = {
      impact: (style) => feedback(craft.haptic(style)),
      notification: (type) => feedback(craft.haptic(type === "error" ? "heavy" : type === "warning" ? "medium" : "light")),
      selection: () => feedback(craft.haptic("soft"))
    };
    craft.storage = Object.assign({ getSync: () => null, setSync: () => {
      return;
    } }, craft.storage || {}, {
      get: (key) => request("Storage", "get", [key]),
      set: (key, value) => request("Storage", "set", [key, value]),
      remove: (key) => request("Storage", "remove", [key]),
      clear: () => request("Storage", "clear", []),
      keys: () => request("Storage", "keys", [])
    });
    craft.secureStorage = Object.assign({ getSync: () => null }, craft.secureStorage || {}, {
      get: (key) => request("SecureStorage", "get", [key]),
      set: (key, value) => request("SecureStorage", "set", [key, value]),
      remove: (key) => request("SecureStorage", "remove", [key]),
      delete: (key) => request("SecureStorage", "remove", [key]),
      clear: () => request("SecureStorage", "clear", [])
    });
    craft.snapshots = Object.assign({ get: () => null, set: () => Promise.resolve(false) }, craft.snapshots || {}, {
      onChange: (callback) => protocol.on("SNAPSHOT_CHANGED", (message) => {
        if (typeof message.payload?.name === "string")
          callback(message.payload.name);
      })
    });
    craft.biometrics = {
      isAvailable: () => request("Biometrics", "isAvailable", []),
      getBiometricType: () => request("Biometrics", "getBiometricType", []),
      authenticate: (reason) => request("Biometrics", "authenticate", [reason || "Authenticate to continue"])
    };
    craft.db = {
      execute: (sql, params = []) => request("Database", "execute", [sql, params]),
      query: (sql, params = []) => request("Database", "query", [sql, params]),
      beginTransaction: () => request("Database", "beginTransaction", []),
      commit: () => request("Database", "commit", []),
      rollback: () => request("Database", "rollback", [])
    };
    craft.notifications = {
      show: (notification) => request("Notifications", "schedule", [notification]),
      schedule: (notification) => request("Notifications", "schedule", [notification]),
      cancel: (id) => request("Notifications", "cancel", [id]),
      cancelAll: () => request("Notifications", "cancelAll", []),
      pending: () => request("Notifications", "pending", [])
    };
    craft.scheduleNotification = craft.notifications.schedule;
    craft.cancelNotification = craft.notifications.cancel;
    craft.cancelAllNotifications = craft.notifications.cancelAll;
    craft.getPendingNotifications = craft.notifications.pending;
    const navigate = (type, screen, params) => {
      if (!routeNames.includes(screen))
        throw Error(`Unknown native screen: ${screen}`);
      if (params !== undefined && (params === null || typeof params !== "object" || Array.isArray(params)))
        throw TypeError("Navigation params must be an object");
      return protocol.send(type, { screen, params: params || {} });
    }, hostSetOptions = craft.navigation && typeof craft.navigation.setOptions === "function" ? craft.navigation.setOptions.bind(craft.navigation) : null;
    craft.navigation = Object.assign(craft.navigation || {}, {
      push: (screen, params) => navigate("NAVIGATE", screen, params),
      replace: (screen, params) => navigate("NAVIGATE_REPLACE", screen, params),
      back: () => protocol.goBack(),
      open: (path) => {
        if (typeof path !== "string" || !path.trim())
          throw TypeError("navigation.open needs a path, such as /m/workout/42");
        return protocol.send("NAVIGATE_OPEN", { path });
      },
      setOptions: (navigationOptions) => {
        if (!navigationOptions || typeof navigationOptions !== "object")
          throw TypeError("navigation.setOptions needs an object");
        const payload = {};
        for (const key of Object.keys(navigationOptions))
          if (key === "rightButtons" && Array.isArray(navigationOptions.rightButtons)) {
            navButtonPresses.clear();
            payload.rightButtons = navigationOptions.rightButtons.map((button) => {
              const { onPress, ...rest } = button || {};
              if (typeof onPress === "function" && rest.id != null)
                navButtonPresses.set(String(rest.id), onPress);
              return rest;
            });
          } else if (typeof navigationOptions[key] !== "function")
            payload[key] = navigationOptions[key];
        return hostSetOptions ? hostSetOptions(payload) : protocol.send("NAVIGATION_SET_OPTIONS", payload);
      },
      onButton: (callback) => {
        if (typeof callback !== "function")
          throw TypeError("navigation.onButton needs a function");
        navButtonHandlers.add(callback);
        return () => navButtonHandlers.delete(callback);
      }
    });
    const onAppStateChange = (callback) => {
      if (typeof callback !== "function")
        throw TypeError("lifecycle.onStateChange needs a function");
      appStateHandlers.add(callback);
      return () => appStateHandlers.delete(callback);
    };
    craft.lifecycle = { getState: () => appState, onStateChange: onAppStateChange, onChange: onAppStateChange };
    craft.getAppState = craft.lifecycle.getState;
    craft.onAppStateChange = onAppStateChange;
    craft.deepLinks = {
      getInitialURL: () => {
        initialDeepLinkClaimed = true;
        return request("DeepLinks", "getInitialURL", []);
      },
      onLink: (callback) => {
        if (typeof callback !== "function")
          throw TypeError("deepLinks.onLink needs a function");
        deepLinkHandlers.add(callback);
        return () => deepLinkHandlers.delete(callback);
      }
    };
    protocol.on("APP_STATE", ({ payload }) => {
      if (payload.state === appState)
        return;
      appState = payload.state;
      appStateHandlers.forEach((handler) => handler(appState));
    });
    protocol.on("DEEP_LINK", ({ payload }) => {
      if (initialDeepLinkClaimed && payload.initial)
        return;
      deepLinkHandlers.forEach((handler) => handler(payload));
    });
    const dispatchNavButton = (event) => {
      const id = event?.id == null ? "" : String(event.id);
      navButtonPresses.get(id)?.({ id });
      navButtonHandlers.forEach((handler) => handler({ id }));
    };
    protocol.on("NAV_BUTTON", ({ payload }) => dispatchNavButton(payload));
    protocol.on("EVENT", ({ payload }) => {
      if (payload?.handlerId === "navButton" || payload?.handlerName === "navButton")
        dispatchNavButton(payload.nativeEvent || {});
    });
    if (capabilities.has("fetch") && typeof target.fetch !== "function")
      target.fetch = (input, init = {}) => {
        const source = input && typeof input === "object" ? input : {}, url = typeof input === "string" ? input : String(source.url || input), method = String(init.method || source.method || "GET").toUpperCase(), headers = {}, inputHeaders = init.headers || source.headers, addHeader = (name, value) => {
          headers[String(name).toLowerCase()] = String(value);
        };
        if (Array.isArray(inputHeaders))
          inputHeaders.forEach((pair) => addHeader(pair[0], pair[1]));
        else if (inputHeaders && typeof inputHeaders.forEach === "function")
          inputHeaders.forEach(addHeader);
        else if (inputHeaders && typeof inputHeaders === "object")
          Object.keys(inputHeaders).forEach((name) => addHeader(name, inputHeaders[name]));
        const body = init.body !== undefined ? init.body : source.body;
        if (body != null && typeof body !== "string")
          return Promise.reject(TypeError("fetch in a native screen sends string bodies only"));
        if (body != null && (method === "GET" || method === "HEAD"))
          return Promise.reject(TypeError("A GET or HEAD request cannot have a body"));
        return request("Network", "fetch", [{ url, method, headers, body: body == null ? null : body }]).then((data) => {
          const responseHeaders = data?.headers && typeof data.headers === "object" ? data.headers : {}, responseBody = data?.body == null ? "" : String(data.body);
          let bodyUsed = false;
          const consume = () => {
            if (bodyUsed)
              return Promise.reject(TypeError("Body has already been consumed"));
            bodyUsed = true;
            return Promise.resolve(responseBody);
          };
          return {
            type: "basic",
            url: data?.url || "",
            status: Number(data?.status) || 0,
            statusText: data?.statusText || "",
            ok: Number(data?.status) >= 200 && Number(data?.status) < 300,
            redirected: Boolean(data?.redirected),
            headers: {
              get: (name) => responseHeaders[String(name).toLowerCase()] == null ? null : String(responseHeaders[String(name).toLowerCase()]),
              has: (name) => responseHeaders[String(name).toLowerCase()] != null,
              forEach: (callback) => Object.keys(responseHeaders).forEach((name) => callback(String(responseHeaders[name]), name))
            },
            get bodyUsed() {
              return bodyUsed;
            },
            text: consume,
            json: () => consume().then(JSON.parse)
          };
        }, (error) => {
          if (error?.code === "INVALID_ARGUMENT")
            throw error;
          const failure = TypeError(error?.message || "Network request failed");
          failure.code = error?.code || "NETWORK_ERROR";
          throw failure;
        });
      };
    return craft;
  }

  // node_modules/@stacksjs/stx/dist/theme-tokens.js
  var SEMANTIC_TOKENS = {
    fg: { light: "neutral-900", dark: "neutral-100", description: "Primary text" },
    "fg-strong": { light: "neutral-700", dark: "neutral-300", description: "Labels, secondary headings" },
    "fg-muted": { light: "neutral-600", dark: "neutral-400", description: "Supporting text" },
    "fg-soft": { light: "neutral-500", dark: "neutral-400", description: "De-emphasised text" },
    "fg-subtle": { light: "neutral-400", dark: "neutral-500", description: "Recessive, non-essential text" },
    surface: { light: "neutral-50", dark: "neutral-800", description: "Page and panel background" },
    "surface-raised": { light: "neutral-100", dark: "neutral-700", description: "Cards, popovers" },
    "surface-sunken": { light: "neutral-200", dark: "neutral-700", description: "Wells, track backgrounds" },
    panel: { light: "white", dark: "neutral-800", description: "Card, menu, dialog surface" },
    field: { light: "white", dark: "neutral-700", description: "Form control surface" },
    page: { light: "neutral-50", dark: "neutral-900", description: "Page background, behind panels" },
    content: { light: "white", dark: "neutral-900", description: "Content area under a chrome header - a table or list body" },
    "surface-hover": { light: "neutral-100", dark: "neutral-700", description: "Row or item highlight on a page or panel" },
    "surface-raised-hover": { light: "neutral-200", dark: "neutral-600", description: "Raised surface, hovered" },
    "surface-sunken-hover": { light: "neutral-300", dark: "neutral-600", description: "Sunken surface, hovered" },
    "field-hover": { light: "neutral-50", dark: "neutral-600", description: "Form control surface, hovered" },
    link: { light: "blue-500", dark: "blue-400", description: "Hyperlink" },
    "link-hover": { light: "blue-600", dark: "blue-300", description: "Hyperlink, hovered" },
    inverse: { light: "neutral-900", dark: "neutral-700", description: "Tooltip bubble, inverted surface" },
    "inverse-ink": { light: "white", dark: "white", description: "Text on an inverted surface" },
    line: { light: "neutral-200", dark: "neutral-700", description: "Default border, divider" },
    "line-strong": { light: "neutral-300", dark: "neutral-600", description: "Input border, focus ring track" },
    "line-hover": { light: "neutral-400", dark: "neutral-500", description: "Border of a hovered control" },
    accent: { light: "blue-600", dark: "blue-400", description: "Primary action, selected state" },
    info: { light: "cyan-600", dark: "cyan-400", description: "Informational emphasis" },
    danger: { light: "red-600", dark: "red-400", description: "Errors, destructive actions" },
    success: { light: "green-600", dark: "green-400", description: "Confirmation" },
    warning: { light: "yellow-600", dark: "yellow-400", description: "Caution" },
    "accent-solid": { light: "blue-500", dark: "blue-600", description: "Primary button fill" },
    "info-solid": { light: "cyan-500", dark: "cyan-600", description: "Informational fill" },
    "danger-solid": { light: "red-500", dark: "red-600", description: "Destructive button fill" },
    "success-solid": { light: "green-500", dark: "green-600", description: "Confirmation fill" },
    "warning-solid": { light: "yellow-500", dark: "yellow-600", description: "Caution fill" },
    "accent-solid-hover": { light: "blue-600", dark: "blue-700", description: "Primary button fill, hovered" },
    "info-solid-hover": { light: "cyan-600", dark: "cyan-700", description: "Informational fill, hovered" },
    "danger-solid-hover": { light: "red-600", dark: "red-700", description: "Destructive fill, hovered" },
    "success-solid-hover": { light: "green-600", dark: "green-700", description: "Confirmation fill, hovered" },
    "warning-solid-hover": { light: "yellow-600", dark: "yellow-700", description: "Caution fill, hovered" },
    "accent-ink": { light: "white", dark: "white", description: "Text on a primary fill" },
    "info-ink": { light: "neutral-900", dark: "neutral-900", description: "Text on an informational fill" },
    "danger-ink": { light: "white", dark: "white", description: "Text on a destructive fill" },
    "success-ink": { light: "neutral-900", dark: "neutral-900", description: "Text on a confirmation fill" },
    "warning-ink": { light: "neutral-900", dark: "neutral-900", description: "Text on a caution fill" },
    "accent-soft": { light: "blue-100", dark: "blue-900", description: "Tinted primary fill" },
    "accent-soft-ink": { light: "blue-800", dark: "blue-200", description: "Text on a tinted primary fill" },
    "info-soft": { light: "cyan-100", dark: "cyan-900", description: "Tinted informational fill" },
    "info-soft-ink": { light: "cyan-800", dark: "cyan-200", description: "Text on a tinted informational fill" },
    "danger-soft": { light: "red-100", dark: "red-900", description: "Tinted destructive fill" },
    "danger-soft-ink": { light: "red-800", dark: "red-200", description: "Text on a tinted destructive fill" },
    "success-soft": { light: "green-100", dark: "green-900", description: "Tinted confirmation fill" },
    "success-soft-ink": { light: "green-800", dark: "green-200", description: "Text on a tinted confirmation fill" },
    "warning-soft": { light: "yellow-100", dark: "yellow-900", description: "Tinted caution fill" },
    "warning-soft-ink": { light: "yellow-800", dark: "yellow-200", description: "Text on a tinted caution fill" },
    secondary: { light: "purple-600", dark: "purple-400", description: "Secondary emphasis" },
    "secondary-solid": { light: "purple-500", dark: "purple-600", description: "Secondary fill" },
    "secondary-solid-hover": { light: "purple-600", dark: "purple-700", description: "Secondary fill, hovered" },
    "secondary-ink": { light: "white", dark: "white", description: "Text on a secondary fill" },
    "secondary-soft": { light: "purple-100", dark: "purple-900", description: "Tinted secondary fill" },
    "secondary-soft-ink": { light: "purple-800", dark: "purple-200", description: "Text on a tinted secondary fill" },
    "danger-fg": { light: "red-900", dark: "red-300", description: "Text in a field with an error" },
    "danger-fg-subtle": { light: "red-300", dark: "red-500", description: "Recessive text in a field with an error" },
    "danger-line": { light: "red-300", dark: "red-600", description: "Border of a field with an error" },
    "danger-focus": { light: "red-500", dark: "red-400", description: "Focus ring of a field with an error" }
  };

  // node_modules/@stacksjs/stx/dist/native/compiler/headwind-to-style.js
  var colors = {
    transparent: "transparent",
    current: "currentColor",
    black: "#000000",
    white: "#ffffff",
    slate: {
      50: "#f8fafc",
      100: "#f1f5f9",
      200: "#e2e8f0",
      300: "#cbd5e1",
      400: "#94a3b8",
      500: "#64748b",
      600: "#475569",
      700: "#334155",
      800: "#1e293b",
      900: "#0f172a",
      950: "#020617"
    },
    gray: {
      50: "#f9fafb",
      100: "#f3f4f6",
      200: "#e5e7eb",
      300: "#d1d5db",
      400: "#9ca3af",
      500: "#6b7280",
      600: "#4b5563",
      700: "#374151",
      800: "#1f2937",
      900: "#111827",
      950: "#030712"
    },
    zinc: {
      50: "#fafafa",
      100: "#f4f4f5",
      200: "#e4e4e7",
      300: "#d4d4d8",
      400: "#a1a1aa",
      500: "#71717a",
      600: "#52525b",
      700: "#3f3f46",
      800: "#27272a",
      900: "#18181b",
      950: "#09090b"
    },
    red: {
      50: "#fef2f2",
      100: "#fee2e2",
      200: "#fecaca",
      300: "#fca5a5",
      400: "#f87171",
      500: "#ef4444",
      600: "#dc2626",
      700: "#b91c1c",
      800: "#991b1b",
      900: "#7f1d1d",
      950: "#450a0a"
    },
    orange: {
      50: "#fff7ed",
      100: "#ffedd5",
      200: "#fed7aa",
      300: "#fdba74",
      400: "#fb923c",
      500: "#f97316",
      600: "#ea580c",
      700: "#c2410c",
      800: "#9a3412",
      900: "#7c2d12",
      950: "#431407"
    },
    amber: {
      50: "#fffbeb",
      100: "#fef3c7",
      200: "#fde68a",
      300: "#fcd34d",
      400: "#fbbf24",
      500: "#f59e0b",
      600: "#d97706",
      700: "#b45309",
      800: "#92400e",
      900: "#78350f",
      950: "#451a03"
    },
    yellow: {
      50: "#fefce8",
      100: "#fef9c3",
      200: "#fef08a",
      300: "#fde047",
      400: "#facc15",
      500: "#eab308",
      600: "#ca8a04",
      700: "#a16207",
      800: "#854d0e",
      900: "#713f12",
      950: "#422006"
    },
    green: {
      50: "#f0fdf4",
      100: "#dcfce7",
      200: "#bbf7d0",
      300: "#86efac",
      400: "#4ade80",
      500: "#22c55e",
      600: "#16a34a",
      700: "#15803d",
      800: "#166534",
      900: "#14532d",
      950: "#052e16"
    },
    emerald: {
      50: "#ecfdf5",
      100: "#d1fae5",
      200: "#a7f3d0",
      300: "#6ee7b7",
      400: "#34d399",
      500: "#10b981",
      600: "#059669",
      700: "#047857",
      800: "#065f46",
      900: "#064e3b",
      950: "#022c22"
    },
    teal: {
      50: "#f0fdfa",
      100: "#ccfbf1",
      200: "#99f6e4",
      300: "#5eead4",
      400: "#2dd4bf",
      500: "#14b8a6",
      600: "#0d9488",
      700: "#0f766e",
      800: "#115e59",
      900: "#134e4a",
      950: "#042f2e"
    },
    cyan: {
      50: "#ecfeff",
      100: "#cffafe",
      200: "#a5f3fc",
      300: "#67e8f9",
      400: "#22d3ee",
      500: "#06b6d4",
      600: "#0891b2",
      700: "#0e7490",
      800: "#155e75",
      900: "#164e63",
      950: "#083344"
    },
    sky: {
      50: "#f0f9ff",
      100: "#e0f2fe",
      200: "#bae6fd",
      300: "#7dd3fc",
      400: "#38bdf8",
      500: "#0ea5e9",
      600: "#0284c7",
      700: "#0369a1",
      800: "#075985",
      900: "#0c4a6e",
      950: "#082f49"
    },
    lime: {
      50: "#f7fee7",
      100: "#ecfccb",
      200: "#d9f99d",
      300: "#bef264",
      400: "#a3e635",
      500: "#84cc16",
      600: "#65a30d",
      700: "#4d7c0f",
      800: "#3f6212",
      900: "#365314",
      950: "#1a2e05"
    },
    fuchsia: {
      50: "#fdf4ff",
      100: "#fae8ff",
      200: "#f5d0fe",
      300: "#f0abfc",
      400: "#e879f9",
      500: "#d946ef",
      600: "#c026d3",
      700: "#a21caf",
      800: "#86198f",
      900: "#701a75",
      950: "#4a044e"
    },
    neutral: {
      50: "#fafafa",
      100: "#f5f5f5",
      200: "#e5e5e5",
      300: "#d4d4d4",
      400: "#a3a3a3",
      500: "#737373",
      600: "#525252",
      700: "#404040",
      800: "#262626",
      900: "#171717",
      950: "#0a0a0a"
    },
    stone: {
      50: "#fafaf9",
      100: "#f5f5f4",
      200: "#e7e5e4",
      300: "#d6d3d1",
      400: "#a8a29e",
      500: "#78716c",
      600: "#57534e",
      700: "#44403c",
      800: "#292524",
      900: "#1c1917",
      950: "#0c0a09"
    },
    blue: {
      50: "#eff6ff",
      100: "#dbeafe",
      200: "#bfdbfe",
      300: "#93c5fd",
      400: "#60a5fa",
      500: "#3b82f6",
      600: "#2563eb",
      700: "#1d4ed8",
      800: "#1e40af",
      900: "#1e3a8a",
      950: "#172554"
    },
    indigo: {
      50: "#eef2ff",
      100: "#e0e7ff",
      200: "#c7d2fe",
      300: "#a5b4fc",
      400: "#818cf8",
      500: "#6366f1",
      600: "#4f46e5",
      700: "#4338ca",
      800: "#3730a3",
      900: "#312e81",
      950: "#1e1b4b"
    },
    violet: {
      50: "#f5f3ff",
      100: "#ede9fe",
      200: "#ddd6fe",
      300: "#c4b5fd",
      400: "#a78bfa",
      500: "#8b5cf6",
      600: "#7c3aed",
      700: "#6d28d9",
      800: "#5b21b6",
      900: "#4c1d95",
      950: "#2e1065"
    },
    purple: {
      50: "#faf5ff",
      100: "#f3e8ff",
      200: "#e9d5ff",
      300: "#d8b4fe",
      400: "#c084fc",
      500: "#a855f7",
      600: "#9333ea",
      700: "#7e22ce",
      800: "#6b21a8",
      900: "#581c87",
      950: "#3b0764"
    },
    pink: {
      50: "#fdf2f8",
      100: "#fce7f3",
      200: "#fbcfe8",
      300: "#f9a8d4",
      400: "#f472b6",
      500: "#ec4899",
      600: "#db2777",
      700: "#be185d",
      800: "#9d174d",
      900: "#831843",
      950: "#500724"
    },
    rose: {
      50: "#fff1f2",
      100: "#ffe4e6",
      200: "#fecdd3",
      300: "#fda4af",
      400: "#fb7185",
      500: "#f43f5e",
      600: "#e11d48",
      700: "#be123c",
      800: "#9f1239",
      900: "#881337",
      950: "#4c0519"
    }
  };
  var spacing = {
    px: 1,
    0: 0,
    0.5: 2,
    1: 4,
    1.5: 6,
    2: 8,
    2.5: 10,
    3: 12,
    3.5: 14,
    4: 16,
    5: 20,
    6: 24,
    7: 28,
    8: 32,
    9: 36,
    10: 40,
    11: 44,
    12: 48,
    14: 56,
    16: 64,
    20: 80,
    24: 96,
    28: 112,
    32: 128,
    36: 144,
    40: 160,
    44: 176,
    48: 192,
    52: 208,
    56: 224,
    60: 240,
    64: 256,
    72: 288,
    80: 320,
    96: 384
  };
  var fontSizes = {
    xs: 12,
    sm: 14,
    base: 16,
    lg: 18,
    xl: 20,
    "2xl": 24,
    "3xl": 30,
    "4xl": 36,
    "5xl": 48,
    "6xl": 60,
    "7xl": 72,
    "8xl": 96,
    "9xl": 128
  };
  var borderRadius = {
    none: 0,
    sm: 2,
    DEFAULT: 4,
    md: 6,
    lg: 8,
    xl: 12,
    "2xl": 16,
    "3xl": 24,
    full: 9999
  };
  function resolveColor(colorClass) {
    const slash = colorClass.lastIndexOf("/");
    if (slash > 0 && !colorClass.endsWith("]")) {
      const base = resolveColor(colorClass.slice(0, slash)), amount = colorClass.slice(slash + 1), alpha = /^\[(.+)\]$/.test(amount) ? Number.parseFloat(amount.slice(1, -1)) * (amount.includes("%") ? 1 : 100) : Number.parseFloat(amount);
      if (!base || !Number.isFinite(alpha))
        return;
      return withAlpha(base, alpha / 100);
    }
    if (colorClass === "transparent")
      return "transparent";
    if (colorClass === "current")
      return "currentColor";
    if (colorClass === "black")
      return "#000000";
    if (colorClass === "white")
      return "#ffffff";
    const parts = colorClass.split("-");
    if (parts.length === 2) {
      const [colorName, shade] = parts, palette = colors[colorName];
      if (palette && typeof palette === "object")
        return palette[shade];
    }
    if (colorClass.startsWith("[") && colorClass.endsWith("]")) {
      const inner = colorClass.slice(1, -1);
      return /^(#|rgba?\(|hsla?\(|[a-z]+$)/i.test(inner) ? inner : undefined;
    }
    return;
  }
  function withAlpha(color, alpha) {
    if (color === "transparent")
      return color;
    let hex = color.startsWith("#") ? color.slice(1) : "";
    if (hex.length === 3)
      hex = hex.split("").map((digit) => digit + digit).join("");
    if (hex.length === 8)
      hex = hex.slice(0, 6);
    if (hex.length !== 6)
      return;
    const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
    return `#${hex}${byte.toString(16).padStart(2, "0")}`;
  }
  function arbitraryLength(value, emBase = 16) {
    if (!value.startsWith("[") || !value.endsWith("]"))
      return;
    const inner = value.slice(1, -1), number = Number.parseFloat(inner);
    if (!Number.isFinite(number))
      return;
    if (inner.endsWith("rem"))
      return number * 16;
    if (inner.endsWith("em"))
      return number * emBase;
    return number;
  }
  function resolveSpacing(value) {
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1), length = inner.endsWith("rem") ? Number.parseFloat(inner) * 16 : Number.parseFloat(inner);
      return Number.isFinite(length) ? length : undefined;
    }
    return spacing[value];
  }
  var classParsers = {
    flex: (_, style) => {
      style.display = "flex";
      return true;
    },
    hidden: (_, style) => {
      style.display = "none";
      return true;
    },
    grid: (_, style) => {
      style.display = "grid";
      return true;
    },
    "flex-row": (_, style) => {
      style.flexDirection = "row";
      return true;
    },
    "flex-col": (_, style) => {
      style.flexDirection = "column";
      return true;
    },
    "flex-row-reverse": (_, style) => {
      style.flexDirection = "row-reverse";
      return true;
    },
    "flex-col-reverse": (_, style) => {
      style.flexDirection = "column-reverse";
      return true;
    },
    "flex-wrap": (_, style) => {
      style.flexWrap = "wrap";
      return true;
    },
    "flex-nowrap": (_, style) => {
      style.flexWrap = "nowrap";
      return true;
    },
    "flex-wrap-reverse": (_, style) => {
      style.flexWrap = "wrap-reverse";
      return true;
    },
    "flex-1": (_, style) => {
      style.flex = 1;
      style.flexGrow = 1;
      style.flexShrink = 1;
      style.flexBasis = 0;
      return true;
    },
    "flex-auto": (_, style) => {
      style.flexGrow = 1;
      style.flexShrink = 1;
      return true;
    },
    "flex-initial": (_, style) => {
      style.flexGrow = 0;
      style.flexShrink = 1;
      return true;
    },
    "flex-none": (_, style) => {
      style.flexGrow = 0;
      style.flexShrink = 0;
      return true;
    },
    grow: (_, style) => {
      style.flexGrow = 1;
      return true;
    },
    "grow-0": (_, style) => {
      style.flexGrow = 0;
      return true;
    },
    shrink: (_, style) => {
      style.flexShrink = 1;
      return true;
    },
    "shrink-0": (_, style) => {
      style.flexShrink = 0;
      return true;
    },
    "justify-start": (_, style) => {
      style.justifyContent = "flex-start";
      return true;
    },
    "justify-center": (_, style) => {
      style.justifyContent = "center";
      return true;
    },
    "justify-end": (_, style) => {
      style.justifyContent = "flex-end";
      return true;
    },
    "justify-between": (_, style) => {
      style.justifyContent = "space-between";
      return true;
    },
    "justify-around": (_, style) => {
      style.justifyContent = "space-around";
      return true;
    },
    "justify-evenly": (_, style) => {
      style.justifyContent = "space-evenly";
      return true;
    },
    "items-start": (_, style) => {
      style.alignItems = "flex-start";
      return true;
    },
    "items-center": (_, style) => {
      style.alignItems = "center";
      return true;
    },
    "items-end": (_, style) => {
      style.alignItems = "flex-end";
      return true;
    },
    "items-stretch": (_, style) => {
      style.alignItems = "stretch";
      return true;
    },
    "items-baseline": (_, style) => {
      style.alignItems = "baseline";
      return true;
    },
    "self-auto": (_, style) => {
      style.alignSelf = "auto";
      return true;
    },
    "self-start": (_, style) => {
      style.alignSelf = "flex-start";
      return true;
    },
    "self-center": (_, style) => {
      style.alignSelf = "center";
      return true;
    },
    "self-end": (_, style) => {
      style.alignSelf = "flex-end";
      return true;
    },
    "self-stretch": (_, style) => {
      style.alignSelf = "stretch";
      return true;
    },
    "self-baseline": (_, style) => {
      style.alignSelf = "baseline";
      return true;
    },
    "min-w-0": (_, style) => {
      style.minWidth = 0;
      return true;
    },
    "aspect-square": (_, style) => {
      style.aspectRatio = 1;
      return true;
    },
    "inset-0": (_, style) => {
      style.top = 0;
      style.right = 0;
      style.bottom = 0;
      style.left = 0;
      return true;
    },
    "tracking-tighter": (_, style) => {
      style.letterSpacing = -0.8;
      return true;
    },
    "tracking-tight": (_, style) => {
      style.letterSpacing = -0.4;
      return true;
    },
    "tracking-normal": (_, style) => {
      style.letterSpacing = 0;
      return true;
    },
    "tracking-wide": (_, style) => {
      style.letterSpacing = 0.4;
      return true;
    },
    "tracking-wider": (_, style) => {
      style.letterSpacing = 0.8;
      return true;
    },
    "tracking-widest": (_, style) => {
      style.letterSpacing = 1.6;
      return true;
    },
    "tabular-nums": () => true,
    block: () => true,
    "inline-flex": (_, style) => {
      style.display = "flex";
      return true;
    },
    truncate: () => true,
    relative: (_, style) => {
      style.position = "relative";
      return true;
    },
    absolute: (_, style) => {
      style.position = "absolute";
      return true;
    },
    "overflow-visible": (_, style) => {
      style.overflow = "visible";
      return true;
    },
    "overflow-hidden": (_, style) => {
      style.overflow = "hidden";
      return true;
    },
    "overflow-scroll": (_, style) => {
      style.overflow = "scroll";
      return true;
    },
    "font-thin": (_, style) => {
      style.fontWeight = "100";
      return true;
    },
    "font-extralight": (_, style) => {
      style.fontWeight = "200";
      return true;
    },
    "font-light": (_, style) => {
      style.fontWeight = "300";
      return true;
    },
    "font-normal": (_, style) => {
      style.fontWeight = "400";
      return true;
    },
    "font-medium": (_, style) => {
      style.fontWeight = "500";
      return true;
    },
    "font-semibold": (_, style) => {
      style.fontWeight = "600";
      return true;
    },
    "font-bold": (_, style) => {
      style.fontWeight = "bold";
      return true;
    },
    "font-extrabold": (_, style) => {
      style.fontWeight = "800";
      return true;
    },
    "font-black": (_, style) => {
      style.fontWeight = "900";
      return true;
    },
    italic: (_, style) => {
      style.fontStyle = "italic";
      return true;
    },
    "not-italic": (_, style) => {
      style.fontStyle = "normal";
      return true;
    },
    "text-left": (_, style) => {
      style.textAlign = "left";
      return true;
    },
    "text-center": (_, style) => {
      style.textAlign = "center";
      return true;
    },
    "text-right": (_, style) => {
      style.textAlign = "right";
      return true;
    },
    "text-justify": (_, style) => {
      style.textAlign = "justify";
      return true;
    },
    uppercase: (_, style) => {
      style.textTransform = "uppercase";
      return true;
    },
    lowercase: (_, style) => {
      style.textTransform = "lowercase";
      return true;
    },
    capitalize: (_, style) => {
      style.textTransform = "capitalize";
      return true;
    },
    "normal-case": (_, style) => {
      style.textTransform = "none";
      return true;
    },
    underline: (_, style) => {
      style.textDecorationLine = "underline";
      return true;
    },
    "line-through": (_, style) => {
      style.textDecorationLine = "line-through";
      return true;
    },
    "no-underline": (_, style) => {
      style.textDecorationLine = "none";
      return true;
    }
  };
  function parseBackgroundColor(className, style) {
    if (!className.startsWith("bg-"))
      return false;
    const colorClass = className.slice(3), color = resolveColor(colorClass);
    if (color) {
      style.backgroundColor = color;
      return true;
    }
    return false;
  }
  function parseTextColor(className, style) {
    if (!className.startsWith("text-"))
      return false;
    const value = className.slice(5);
    if (fontSizes[value]) {
      style.fontSize = fontSizes[value];
      return true;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1);
      if (/^-?[\d.]+(?:px|r?em)?$/.test(inner)) {
        const size = inner.endsWith("rem") || inner.endsWith("em") ? Number.parseFloat(inner) * 16 : Number.parseFloat(inner);
        if (Number.isFinite(size)) {
          style.fontSize = size;
          return true;
        }
      }
    }
    const color = resolveColor(value);
    if (color) {
      style.color = color;
      return true;
    }
    return false;
  }
  function parsePadding(className, style) {
    if (className.startsWith("p-")) {
      const size = resolveSpacing(className.slice(2));
      if (size !== undefined) {
        style.padding = size;
        return true;
      }
    }
    if (className.startsWith("px-")) {
      const size = resolveSpacing(className.slice(3));
      if (size !== undefined) {
        style.paddingHorizontal = size;
        return true;
      }
    }
    if (className.startsWith("py-")) {
      const size = resolveSpacing(className.slice(3));
      if (size !== undefined) {
        style.paddingVertical = size;
        return true;
      }
    }
    if (className.startsWith("pt-")) {
      const size = resolveSpacing(className.slice(3));
      if (size !== undefined) {
        style.paddingTop = size;
        return true;
      }
    }
    if (className.startsWith("pr-")) {
      const size = resolveSpacing(className.slice(3));
      if (size !== undefined) {
        style.paddingRight = size;
        return true;
      }
    }
    if (className.startsWith("pb-")) {
      const size = resolveSpacing(className.slice(3));
      if (size !== undefined) {
        style.paddingBottom = size;
        return true;
      }
    }
    if (className.startsWith("pl-")) {
      const size = resolveSpacing(className.slice(3));
      if (size !== undefined) {
        style.paddingLeft = size;
        return true;
      }
    }
    return false;
  }
  function parseMargin(className, style) {
    if (className.startsWith("m-")) {
      const size = resolveSpacing(className.slice(2));
      if (size !== undefined) {
        style.margin = size;
        return true;
      }
    }
    if (className.startsWith("mx-")) {
      const size = resolveSpacing(className.slice(3));
      if (size !== undefined) {
        style.marginHorizontal = size;
        return true;
      }
    }
    if (className.startsWith("my-")) {
      const size = resolveSpacing(className.slice(3));
      if (size !== undefined) {
        style.marginVertical = size;
        return true;
      }
    }
    if (className.startsWith("mt-")) {
      const size = resolveSpacing(className.slice(3));
      if (size !== undefined) {
        style.marginTop = size;
        return true;
      }
    }
    if (className.startsWith("mr-")) {
      const size = resolveSpacing(className.slice(3));
      if (size !== undefined) {
        style.marginRight = size;
        return true;
      }
    }
    if (className.startsWith("mb-")) {
      const size = resolveSpacing(className.slice(3));
      if (size !== undefined) {
        style.marginBottom = size;
        return true;
      }
    }
    if (className.startsWith("ml-")) {
      const size = resolveSpacing(className.slice(3));
      if (size !== undefined) {
        style.marginLeft = size;
        return true;
      }
    }
    return false;
  }
  function parseWidth(className, style) {
    if (!className.startsWith("w-"))
      return false;
    const value = className.slice(2);
    if (value === "full") {
      style.width = "100%";
      return true;
    }
    if (value === "screen") {
      style.width = "100%";
      return true;
    }
    if (value === "auto") {
      style.width = "auto";
      return true;
    }
    if (value.includes("/")) {
      const [num, denom] = value.split("/"), percent = Number.parseInt(num) / Number.parseInt(denom) * 100;
      style.width = `${percent}%`;
      return true;
    }
    const size = resolveSpacing(value);
    if (size !== undefined) {
      style.width = size;
      return true;
    }
    return false;
  }
  function parseHeight(className, style) {
    if (!className.startsWith("h-"))
      return false;
    const value = className.slice(2);
    if (value === "full") {
      style.height = "100%";
      return true;
    }
    if (value === "screen") {
      style.height = "100%";
      return true;
    }
    if (value === "auto") {
      style.height = "auto";
      return true;
    }
    const size = resolveSpacing(value);
    if (size !== undefined) {
      style.height = size;
      return true;
    }
    return false;
  }
  function parseBorderRadius(className, style) {
    if (!className.startsWith("rounded"))
      return false;
    if (className === "rounded") {
      style.borderRadius = borderRadius.DEFAULT;
      return true;
    }
    const value = className.slice(8);
    if (value === "")
      return false;
    const corner = /^(?:(t|b|l|r)-)?(\[[^\]]+\])$/.exec(value);
    if (corner) {
      const r = arbitraryLength(corner[2]);
      if (r === undefined)
        return false;
      const corners = {
        t: ["borderTopLeftRadius", "borderTopRightRadius"],
        b: ["borderBottomLeftRadius", "borderBottomRightRadius"],
        l: ["borderTopLeftRadius", "borderBottomLeftRadius"],
        r: ["borderTopRightRadius", "borderBottomRightRadius"]
      };
      for (const key of corner[1] ? corners[corner[1]] : ["borderRadius"])
        style[key] = r;
      return true;
    }
    if (value.startsWith("t-")) {
      const r = borderRadius[value.slice(2)] ?? borderRadius.DEFAULT;
      style.borderTopLeftRadius = r;
      style.borderTopRightRadius = r;
      return true;
    }
    if (value.startsWith("b-")) {
      const r = borderRadius[value.slice(2)] ?? borderRadius.DEFAULT;
      style.borderBottomLeftRadius = r;
      style.borderBottomRightRadius = r;
      return true;
    }
    if (value.startsWith("l-")) {
      const r = borderRadius[value.slice(2)] ?? borderRadius.DEFAULT;
      style.borderTopLeftRadius = r;
      style.borderBottomLeftRadius = r;
      return true;
    }
    if (value.startsWith("r-")) {
      const r = borderRadius[value.slice(2)] ?? borderRadius.DEFAULT;
      style.borderTopRightRadius = r;
      style.borderBottomRightRadius = r;
      return true;
    }
    const radius = borderRadius[value];
    if (radius !== undefined) {
      style.borderRadius = radius;
      return true;
    }
    return false;
  }
  function parseBorderWidth(className, style) {
    if (!className.startsWith("border"))
      return false;
    if (className === "border") {
      style.borderWidth = 1;
      return true;
    }
    const match = className.match(/^border-(\d+)$/);
    if (match) {
      style.borderWidth = Number.parseInt(match[1]);
      return true;
    }
    const sideMatch = className.match(/^border-(t|r|b|l)-?(\d*)$/);
    if (sideMatch) {
      const [, side, width] = sideMatch, w = width ? Number.parseInt(width) : 1;
      switch (side) {
        case "t":
          style.borderTopWidth = w;
          break;
        case "r":
          style.borderRightWidth = w;
          break;
        case "b":
          style.borderBottomWidth = w;
          break;
        case "l":
          style.borderLeftWidth = w;
          break;
      }
      return true;
    }
    return false;
  }
  function parseBorderColor(className, style) {
    if (!className.startsWith("border-"))
      return false;
    const colorClass = className.slice(7), color = resolveColor(colorClass);
    if (color) {
      style.borderColor = color;
      return true;
    }
    return false;
  }
  function parseOpacity(className, style) {
    if (!className.startsWith("opacity-"))
      return false;
    const value = Number.parseInt(className.slice(8));
    if (!Number.isNaN(value)) {
      style.opacity = value / 100;
      return true;
    }
    return false;
  }
  function parseTypography(className, style) {
    if (className.startsWith("tracking-[")) {
      const value = arbitraryLength(className.slice(9), typeof style.fontSize === "number" ? style.fontSize : 16);
      if (value === undefined)
        return false;
      style.letterSpacing = value;
      return true;
    }
    if (className.startsWith("leading-")) {
      const value = className.slice(8), size = typeof style.fontSize === "number" ? style.fontSize : 16, ratios = { none: 1, tight: 1.25, snug: 1.375, normal: 1.5, relaxed: 1.625, loose: 2 }, length = value.startsWith("[") ? /^\[[\d.]+\]$/.test(value) ? Number.parseFloat(value.slice(1, -1)) * size : arbitraryLength(value, size) : ratios[value] !== undefined ? ratios[value] * size : spacing[value];
      if (length === undefined || !Number.isFinite(length))
        return false;
      style.lineHeight = length;
      return true;
    }
    return false;
  }
  function parseGridColumns(className, style) {
    const match = /^grid-cols-(\d+)$/.exec(className);
    if (!match)
      return false;
    style.gridColumns = Number(match[1]);
    return true;
  }
  function parseSize(className, style) {
    if (!className.startsWith("size-"))
      return false;
    const value = className.slice(5), size = value === "full" ? "100%" : resolveSpacing(value);
    if (size === undefined)
      return false;
    style.width = size;
    style.height = size;
    return true;
  }
  function parsePosition(className, style) {
    const match = /^(-?)(top|right|bottom|left)-(.+)$/.exec(className);
    if (!match)
      return false;
    const size = match[3] === "full" ? "100%" : resolveSpacing(match[3]);
    if (size === undefined)
      return false;
    style[match[2]] = typeof size === "number" && match[1] ? -size : size;
    return true;
  }
  function parseSpace(className, style) {
    const match = /^space-(x|y)-(.+)$/.exec(className);
    if (!match)
      return false;
    const size = resolveSpacing(match[2]);
    if (size === undefined)
      return false;
    style.gap = size;
    return true;
  }
  function parseGap(className, style) {
    if (className.startsWith("gap-")) {
      const size = resolveSpacing(className.slice(4));
      if (size !== undefined) {
        style.gap = size;
        return true;
      }
    }
    if (className.startsWith("gap-x-")) {
      const size = resolveSpacing(className.slice(6));
      if (size !== undefined) {
        style.columnGap = size;
        return true;
      }
    }
    if (className.startsWith("gap-y-")) {
      const size = resolveSpacing(className.slice(6));
      if (size !== undefined) {
        style.rowGap = size;
        return true;
      }
    }
    return false;
  }
  function compileClassStyles(classes) {
    const plain = [], dark = [], semanticDark = [];
    function roleClass(name, scheme) {
      const match = /^(text|bg|border|ring)-([a-z-]+)(\/[^\s]+)?$/.exec(name), role = match && SEMANTIC_TOKENS[match[2]];
      return role ? `${match[1]}-${role[scheme]}${match[3] || ""}` : name;
    }
    for (const name of classes.split(/\s+/).filter(Boolean))
      if (name.startsWith("dark:"))
        dark.push(roleClass(name.slice(5), "dark"));
      else if (!name.includes(":") || name.startsWith("[")) {
        plain.push(roleClass(name, "light"));
        if (roleClass(name, "dark") !== name)
          semanticDark.push(roleClass(name, "dark"));
      }
    const unknown = [], result = { style: compileHeadwindToStyle(plain.join(" "), unknown), unknown };
    if (dark.length || semanticDark.length)
      result.dark = compileHeadwindToStyle([...semanticDark, ...dark].join(" "), unknown);
    for (const name of plain) {
      if (name === "truncate")
        result.numberOfLines = 1;
      const clamp = /^line-clamp-(\d+)$/.exec(name);
      if (clamp)
        result.numberOfLines = Number(clamp[1]);
      if (!result.icon && /^i-[a-z0-9]+-[a-z0-9-]+$/.test(name))
        result.icon = name;
    }
    result.unknown = unknown.filter((name) => !/^line-clamp-\d+$/.test(name));
    return result;
  }
  function compileHeadwindToStyle(classes, unknown) {
    const style = {}, classNames = classes.split(/\s+/).filter(Boolean);
    for (const className of classNames) {
      if (/^i-[a-z0-9]+-/.test(className))
        continue;
      const exactParser = classParsers[className];
      if (exactParser) {
        exactParser("", style);
        continue;
      }
      if (parseBackgroundColor(className, style))
        continue;
      if (parseTextColor(className, style))
        continue;
      if (parsePadding(className, style))
        continue;
      if (parseMargin(className, style))
        continue;
      if (parseWidth(className, style))
        continue;
      if (parseHeight(className, style))
        continue;
      if (parseBorderRadius(className, style))
        continue;
      if (parseBorderWidth(className, style))
        continue;
      if (parseBorderColor(className, style))
        continue;
      if (parseOpacity(className, style))
        continue;
      if (parseGap(className, style))
        continue;
      if (parseTypography(className, style))
        continue;
      if (parseSize(className, style))
        continue;
      if (parseGridColumns(className, style))
        continue;
      if (parsePosition(className, style))
        continue;
      if (parseSpace(className, style))
        continue;
      unknown?.push(className);
      if (typeof process < "u" && process.env?.NODE_ENV === "development")
        console.warn(`[STX Native] Unknown Headwind class: ${className}`);
    }
    return style;
  }

  // node_modules/@stacksjs/stx/dist/native/compiler/icons.js
  var FALLBACK_SYMBOL = "circle";
  var LUCIDE_TO_SF = {
    activity: "waveform.path.ecg",
    "alarm-clock": "alarm",
    "alert-circle": "exclamationmark.circle",
    "alert-triangle": "exclamationmark.triangle",
    archive: "archivebox",
    "arrow-down": "arrow.down",
    "arrow-left": "arrow.left",
    "arrow-right": "arrow.right",
    "arrow-up": "arrow.up",
    "arrow-up-right": "arrow.up.right",
    "at-sign": "at",
    "audio-lines": "waveform",
    award: "rosette",
    "badge-check": "checkmark.seal",
    "bar-chart": "chart.bar",
    "bar-chart-2": "chart.bar",
    "bar-chart-3": "chart.bar",
    battery: "battery.100",
    bed: "bed.double",
    bell: "bell",
    "bell-off": "bell.slash",
    bike: "figure.outdoor.cycle",
    bluetooth: "antenna.radiowaves.left.and.right",
    book: "book",
    "book-open": "book",
    bookmark: "bookmark",
    brain: "brain",
    calendar: "calendar",
    "calendar-check": "calendar.badge.checkmark",
    "calendar-clock": "calendar.badge.clock",
    "calendar-days": "calendar",
    "calendar-plus": "calendar.badge.plus",
    "calendar-range": "calendar",
    "calendar-sync": "arrow.triangle.2.circlepath",
    camera: "camera",
    "chart-bar": "chart.bar",
    "chart-line": "chart.xyaxis.line",
    check: "checkmark",
    "check-circle": "checkmark.circle",
    "check-circle-2": "checkmark.circle",
    "chevron-down": "chevron.down",
    "chevron-left": "chevron.left",
    "chevron-right": "chevron.right",
    "chevron-up": "chevron.up",
    circle: "circle",
    "circle-alert": "exclamationmark.circle",
    "circle-check": "checkmark.circle",
    "circle-check-big": "checkmark.circle",
    "circle-help": "questionmark.circle",
    "circle-play": "play.circle",
    "circle-plus": "plus.circle",
    "circle-user": "person.crop.circle",
    "circle-x": "xmark.circle",
    clapperboard: "film",
    clipboard: "clipboard",
    "clipboard-list": "list.clipboard",
    clock: "clock",
    cloud: "cloud",
    "cloud-off": "icloud.slash",
    coffee: "cup.and.saucer",
    copy: "doc.on.doc",
    "credit-card": "creditcard",
    download: "arrow.down.circle",
    droplet: "drop",
    droplets: "drop",
    dumbbell: "dumbbell",
    edit: "pencil",
    "external-link": "arrow.up.right.square",
    eye: "eye",
    "eye-off": "eye.slash",
    file: "doc",
    "file-text": "doc.text",
    filter: "line.3.horizontal.decrease",
    flag: "flag",
    flame: "flame",
    "flower-2": "camera.macro",
    footprints: "figure.run",
    gauge: "gauge",
    gift: "gift",
    globe: "globe",
    "graduation-cap": "graduationcap",
    "grip-vertical": "line.3.horizontal",
    heart: "heart",
    "heart-pulse": "heart.text.square",
    "help-circle": "questionmark.circle",
    history: "clock.arrow.circlepath",
    home: "house",
    house: "house",
    image: "photo",
    inbox: "tray",
    info: "info.circle",
    layers: "square.3.layers.3d",
    "layout-grid": "square.grid.2x2",
    library: "books.vertical",
    link: "link",
    list: "list.bullet",
    "list-checks": "checklist",
    loader: "arrow.triangle.2.circlepath",
    "loader-2": "arrow.triangle.2.circlepath",
    "loader-circle": "arrow.triangle.2.circlepath",
    lock: "lock",
    "log-in": "arrow.right.to.line",
    "log-out": "rectangle.portrait.and.arrow.right",
    mail: "envelope",
    map: "map",
    "map-pin": "mappin.and.ellipse",
    medal: "medal",
    menu: "line.3.horizontal",
    "message-circle": "bubble.left",
    "message-square": "text.bubble",
    "message-square-quote": "quote.bubble",
    mic: "mic",
    minus: "minus",
    moon: "moon",
    "more-horizontal": "ellipsis",
    "more-vertical": "ellipsis",
    mountain: "mountain.2",
    music: "music.note",
    package: "shippingbox",
    pause: "pause",
    "pause-circle": "pause.circle",
    pencil: "pencil",
    "person-standing": "figure.walk",
    phone: "phone",
    play: "play.fill",
    plug: "powerplug",
    plus: "plus",
    "plus-circle": "plus.circle",
    "refresh-cw": "arrow.clockwise",
    repeat: "repeat",
    "rotate-ccw": "arrow.counterclockwise",
    route: "point.topleft.down.to.point.bottomright.curvepath",
    ruler: "ruler",
    sailboat: "sailboat",
    satellite: "antenna.radiowaves.left.and.right",
    save: "square.and.arrow.down",
    scale: "scalemass",
    search: "magnifyingglass",
    send: "paperplane",
    settings: "gearshape",
    "settings-2": "slider.horizontal.3",
    share: "square.and.arrow.up",
    "share-2": "square.and.arrow.up",
    shield: "shield",
    "shield-check": "checkmark.shield",
    "shopping-bag": "bag",
    "shopping-cart": "cart",
    "skip-back": "backward.end",
    "skip-forward": "forward.end",
    sliders: "slider.horizontal.3",
    "sliders-horizontal": "slider.horizontal.3",
    smartphone: "iphone",
    snowflake: "snowflake",
    sparkles: "sparkles",
    square: "square",
    star: "star",
    stopwatch: "stopwatch",
    store: "storefront",
    sun: "sun.max",
    sunrise: "sunrise",
    sunset: "sunset",
    tag: "tag",
    target: "scope",
    thermometer: "thermometer.medium",
    "thumbs-up": "hand.thumbsup",
    timer: "timer",
    trash: "trash",
    "trash-2": "trash",
    "trending-down": "chart.line.downtrend.xyaxis",
    "trending-up": "chart.line.uptrend.xyaxis",
    trophy: "trophy",
    unlink: "personalhotspot.slash",
    upload: "arrow.up.circle",
    user: "person",
    "user-plus": "person.badge.plus",
    "user-round": "person",
    users: "person.2",
    video: "video",
    "volume-2": "speaker.wave.2",
    watch: "applewatch",
    waves: "figure.pool.swim",
    weight: "scalemass",
    wifi: "wifi",
    "wifi-off": "wifi.slash",
    wind: "wind",
    x: "xmark",
    "x-circle": "xmark.circle",
    zap: "bolt"
  };
  function resolveIconName(name, asSymbol = false) {
    const value = String(name ?? "").trim();
    if (!value)
      return { symbol: FALLBACK_SYMBOL, known: false };
    if (asSymbol)
      return { symbol: value, known: true };
    const prefixed = /^i-([a-z0-9]+)-(.+)$/.exec(value) ?? /^([a-z0-9]+):(.+)$/.exec(value), collection = prefixed ? prefixed[1] : "lucide", icon = prefixed ? prefixed[2] : value;
    if (collection === "lucide") {
      const symbol = LUCIDE_TO_SF[icon];
      if (symbol)
        return { symbol, iconify: `i-lucide-${icon}`, known: true };
      if (!prefixed && value.includes("."))
        return { symbol: value, known: true };
    }
    return { symbol: FALLBACK_SYMBOL, iconify: prefixed ? value : `i-lucide-${icon}`, known: false };
  }

  // node_modules/@stacksjs/stx/dist/native/prop-names.js
  var NATIVE_PROP_NAMES = [
    "accessibilityHint",
    "accessibilityLabel",
    "accessibilityRole",
    "accessibilityState",
    "accessibilityValue",
    "activeOpacity",
    "alwaysBounceHorizontal",
    "alwaysBounceVertical",
    "animationType",
    "autoCapitalize",
    "autoCorrect",
    "autoFocus",
    "blurRadius",
    "contentContainerStyle",
    "defaultSource",
    "defaultValue",
    "ellipsizeMode",
    "fadeDuration",
    "hidesWhenStopped",
    "hitSlop",
    "imageStyle",
    "initialNumToRender",
    "iosBackgroundColor",
    "keyboardDismissMode",
    "keyboardShouldPersistTaps",
    "keyboardType",
    "keyboardVerticalOffset",
    "keyExtractor",
    "maxLength",
    "maximumTrackTintColor",
    "maximumValue",
    "maxToRenderPerBatch",
    "minimumTrackTintColor",
    "minimumValue",
    "numberOfLines",
    "numColumns",
    "onEndReachedThreshold",
    "pagingEnabled",
    "placeholderTextColor",
    "pointerEvents",
    "presentationStyle",
    "pressRetentionOffset",
    "progressBackgroundColor",
    "progressViewOffset",
    "refreshControl",
    "resizeMode",
    "returnKeyType",
    "scrollEnabled",
    "scrollTarget",
    "secureTextEntry",
    "selectedValue",
    "selectionColor",
    "showsHorizontalScrollIndicator",
    "showsVerticalScrollIndicator",
    "statusBarTranslucent",
    "stickyHeaderIndices",
    "testID",
    "thumbColor",
    "thumbTintColor",
    "titleColor",
    "trackColor",
    "underlayColor",
    "windowSize"
  ];
  var nativePropNames = new Map(NATIVE_PROP_NAMES.map((name) => [normaliseKey(name), name]));
  function normaliseKey(name) {
    return name.replace(/[-_]/g, "").toLowerCase();
  }
  function nativePropName(name) {
    return nativePropNames.get(normaliseKey(name)) ?? name;
  }

  // node_modules/@stacksjs/stx/dist/native/runtime/native-host.js
  var NATIVE_EVENT_NAMES = {
    click: "onPress",
    press: "onPress",
    longpress: "onLongPress",
    contextmenu: "onLongPress",
    input: "onChangeText",
    change: "onValueChange",
    focus: "onFocus",
    focusin: "onFocus",
    blur: "onBlur",
    focusout: "onBlur",
    submit: "onSubmitEditing",
    scroll: "onScroll",
    refresh: "onRefresh",
    close: "onRequestClose"
  };
  function createNativeHost(options) {
    const records = new Map, handlers = new Map;
    let queue = [], scheduled = false, counter = 0, colorScheme = options.colorScheme ?? "light";
    const schedule = options.schedule ?? ((flush) => queueMicrotask(flush)), nextId = (prefix) => `${prefix}${++counter}`;
    function flush() {
      scheduled = false;
      if (queue.length === 0)
        return;
      const batch = queue;
      queue = [];
      options.send(batch);
    }
    function emit(operation) {
      queue.push(operation);
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    }
    function recordOf(node) {
      let record = records.get(node.__stxId);
      if (!record) {
        record = { type: "View", props: {}, style: {}, baseStyle: {}, classes: "", events: {}, children: [], visible: true, materialized: true };
        records.set(node.__stxId, record);
      }
      return record;
    }
    function descriptorOf(node) {
      return records.get(node.__stxId) ?? node.__stxDetachedRecord;
    }
    function retainDetachedDescriptors(node) {
      const record = records.get(node.__stxId);
      if (!record)
        return;
      node.__stxDetachedRecord = record;
      record.children.forEach(retainDetachedDescriptors);
      records.delete(node.__stxId);
    }
    function releaseHandlers(node) {
      const record = descriptorOf(node);
      if (!record)
        return;
      Object.values(record.events).forEach((handlerId) => handlers.delete(handlerId));
      record.children.forEach(releaseHandlers);
    }
    function materialize(node) {
      const record = recordOf(node);
      if (record.materialized || node.__stxAnchor !== undefined)
        return;
      record.style = resolveStyle(record);
      record.materialized = true;
      emit({
        op: "createNode",
        id: node.__stxId,
        node: {
          type: record.type,
          props: { ...record.props },
          style: { ...record.style },
          ...record.text === undefined ? {} : { children: [record.text] }
        }
      });
      let index = 0;
      for (const child of record.children) {
        if (child.__stxAnchor !== undefined)
          continue;
        materialize(child);
        emit({ op: "insertChild", parentId: node.__stxId, childId: child.__stxId, index: index++ });
      }
    }
    function resolveStyle(record) {
      const classes = compileClassStyles(record.classes);
      return { ...classes.style, ...colorScheme === "dark" ? classes.dark : {}, ...record.baseStyle };
    }
    function applyClasses(id, record) {
      const style = resolveStyle(record), patch = Object.fromEntries(Object.keys(record.style).filter((key) => !(key in style)).map((key) => [key, null]));
      record.style = style;
      if (record.materialized)
        emit({ op: "updateNode", id, patch: { style: { ...patch, ...style } } });
      const classes = compileClassStyles(record.classes);
      if (record.type === "Icon" && classes.icon) {
        record.props.symbol = resolveIconName(classes.icon).symbol;
        if (record.materialized)
          emit({ op: "updateNode", id, patch: { props: { symbol: record.props.symbol } } });
      }
      if (classes.numberOfLines !== undefined) {
        record.props.numberOfLines = classes.numberOfLines;
        if (record.materialized)
          emit({ op: "updateNode", id, patch: { props: { numberOfLines: classes.numberOfLines } } });
      }
    }
    function collectDescendants(node) {
      const out = [], visit = (current) => {
        const record = records.get(current.__stxId);
        if (!record)
          return;
        for (const child of record.children) {
          out.push(child);
          visit(child);
        }
      };
      if (node)
        visit(node);
      return out;
    }
    function isBindingNode(node) {
      return node.nodeType === 1;
    }
    function decoratePosition(node) {
      const target = node;
      if (target.__stxPositionDecorated)
        return;
      Object.defineProperties(target, {
        nextSibling: {
          configurable: true,
          get() {
            const owner = target.__stxOwner;
            if (!owner)
              return null;
            const siblings = recordOf(owner).children, index = siblings.findIndex((candidate) => candidate.__stxId === target.__stxId);
            return index === -1 ? null : siblings[index + 1] ?? null;
          }
        },
        nextElementSibling: {
          configurable: true,
          get() {
            let sibling = target.nextSibling;
            while (sibling && !isBindingNode(sibling))
              sibling = sibling.nextSibling;
            return sibling;
          }
        }
      });
      target.__stxPositionDecorated = true;
    }
    function setConnected(node, connected) {
      if ("isConnected" in node)
        node.isConnected = connected;
      records.get(node.__stxId)?.children.forEach((child) => setConnected(child, connected));
    }
    function removeFromBindingParent(node) {
      const owner = node.__stxOwner;
      if (!owner || !isBindingNode(owner))
        return;
      owner.childNodes = owner.childNodes.filter((child) => child.__stxId !== node.__stxId);
      owner.children = owner.children.filter((child) => child.__stxId !== node.__stxId);
    }
    function insertIntoBindingParent(parent, node, index) {
      if (!isBindingNode(parent))
        return;
      parent.childNodes.splice(index, 0, node);
      parent.children.splice(index, 0, node);
      if (isBindingNode(node)) {
        node.parentNode = parent;
        node.parentElement = parent;
      }
    }
    function adopt(node, type, owner, descriptor) {
      const suffix = /(?:^|\D)(\d+)$/.exec(node.__stxId)?.[1];
      if (suffix)
        counter = Math.max(counter, Number(suffix));
      const classes = descriptor?._classes ?? "", classStyle = compileClassStyles(classes).style, baseStyle = descriptor?._inlineStyle ? { ...descriptor._inlineStyle } : Object.fromEntries(Object.entries(descriptor?.style ?? {}).filter(([key, value]) => classStyle[key] !== value)), record = {
        type,
        props: { ...descriptor?.props ?? {} },
        style: { ...descriptor?.style ?? {} },
        baseStyle,
        classes,
        events: { ...descriptor?.events ?? {} },
        text: descriptor?.children?.find((child) => typeof child === "string"),
        children: [],
        visible: true,
        materialized: true
      };
      record.style = resolveStyle(record);
      if (descriptor)
        descriptor.style = { ...record.style };
      records.set(node.__stxId, record);
      decoratePosition(node);
      node.__stxOwner = owner ?? null;
      if (owner) {
        const children = recordOf(owner).children;
        if (!children.some((child) => child.__stxId === node.__stxId))
          children.push(node);
      }
      return node;
    }
    return {
      adopt,
      setColorScheme(scheme) {
        if (scheme === colorScheme)
          return;
        colorScheme = scheme;
        for (const [id, record] of records)
          applyClasses(id, record);
      },
      pending: () => queue.length,
      flush,
      setText(node, value) {
        const text = value == null ? "" : String(value);
        recordOf(node).text = text;
        emit({ op: "updateNode", id: node.__stxId, patch: { children: [text] } });
      },
      setAttribute(node, name, value) {
        if (name === "class" || name === "className") {
          const record = recordOf(node);
          record.classes = String(value ?? "");
          applyClasses(node.__stxId, record);
          return;
        }
        const prop = nativePropName(name);
        recordOf(node).props[prop] = value;
        if (recordOf(node).type === "Icon" && prop === "name")
          this.setAttribute(node, "symbol", resolveIconName(String(value ?? "")).symbol);
        emit({ op: "updateNode", id: node.__stxId, patch: { props: { [prop]: value } } });
      },
      removeAttribute(node, name) {
        if (name === "class" || name === "className") {
          this.setAttribute(node, name, "");
          return;
        }
        const prop = nativePropName(name);
        delete recordOf(node).props[prop];
        emit({ op: "updateNode", id: node.__stxId, patch: { props: { [prop]: null } } });
      },
      setStyle(node, value) {
        if (typeof value !== "object" || value === null || Array.isArray(value))
          return;
        const style = value;
        Object.assign(recordOf(node).baseStyle, style);
        Object.assign(recordOf(node).style, style);
        emit({ op: "updateNode", id: node.__stxId, patch: { style } });
      },
      listen(node, event, handler) {
        const id = nextId("h"), nativeEvent = NATIVE_EVENT_NAMES[event.toLowerCase()] ?? event;
        handlers.set(id, handler);
        recordOf(node).events[nativeEvent] = id;
        emit({ op: "updateNode", id: node.__stxId, patch: { events: { [nativeEvent]: id } } });
      },
      dispatch(handlerId, payload) {
        handlers.get(handlerId)?.(payload);
      },
      scopeOf(node, from) {
        let current = from ? node?.__stxOwner : node;
        while (current) {
          if (current.__stxScope !== undefined)
            return current;
          current = current.__stxOwner;
        }
        return null;
      },
      setVisible(node, visible) {
        const record = recordOf(node), was = record.visible;
        record.visible = visible;
        record.baseStyle.display = visible ? "flex" : "none";
        emit({ op: "updateNode", id: node.__stxId, patch: { style: { display: visible ? "flex" : "none" } } });
        return was;
      },
      anchor(label) {
        const anchor = { __stxId: nextId("a"), __stxAnchor: label };
        decoratePosition(anchor);
        return anchor;
      },
      clone(node) {
        const source = descriptorOf(node), id = nextId("n"), copy = isBindingNode(node) ? cloneNativeBindingNode(node, id, (value) => this.setAttribute(copy, "class", value)) : { __stxId: id, __stxOwner: node.__stxOwner };
        decoratePosition(copy);
        if (node.__stxScope !== undefined)
          copy.__stxScope = node.__stxScope;
        const descriptor = source ?? {
          type: "View",
          props: {},
          style: {},
          baseStyle: {},
          classes: "",
          events: {},
          children: [],
          visible: true,
          materialized: true
        };
        records.set(copy.__stxId, {
          type: descriptor.type,
          props: { ...descriptor.props, __stxId: copy.__stxId },
          style: { ...descriptor.style },
          baseStyle: { ...descriptor.baseStyle },
          classes: descriptor.classes,
          events: { ...descriptor.events },
          text: descriptor.text,
          children: [],
          visible: descriptor.visible,
          materialized: false
        });
        setConnected(copy, false);
        for (const child of descriptor.children) {
          const childCopy = this.clone(child);
          this.insert(copy, childCopy);
        }
        return copy;
      },
      insert(parent, node, before) {
        const record = recordOf(parent), oldOwner = node.__stxOwner, existing = record.children.findIndex((child) => child.__stxId === node.__stxId);
        if (existing !== -1)
          record.children.splice(existing, 1);
        else if (oldOwner) {
          const oldRecord = recordOf(oldOwner), oldIndex = oldRecord.children.findIndex((child) => child.__stxId === node.__stxId);
          if (oldIndex !== -1)
            oldRecord.children.splice(oldIndex, 1);
        }
        removeFromBindingParent(node);
        const index = before ? Math.max(0, record.children.findIndex((child) => child.__stxId === before.__stxId)) : record.children.length;
        record.children.splice(index, 0, node);
        node.__stxOwner = parent;
        insertIntoBindingParent(parent, node, index);
        setConnected(node, record.materialized);
        if (node.__stxAnchor !== undefined || !record.materialized)
          return;
        materialize(node);
        emit({
          op: existing === -1 ? "insertChild" : "moveChild",
          parentId: parent.__stxId,
          childId: node.__stxId,
          index
        });
      },
      descendants: collectDescendants,
      scopesIn(node) {
        const ids = [];
        if (!node)
          return ids;
        if (node.__stxScope !== undefined)
          ids.push(node.__stxScope);
        for (const child of collectDescendants(node))
          if (child.__stxScope !== undefined)
            ids.push(child.__stxScope);
        return ids;
      },
      remove(node) {
        const wasMaterialized = descriptorOf(node)?.materialized === true, owner = node.__stxOwner;
        if (owner) {
          const record = recordOf(owner), at = record.children.findIndex((child) => child.__stxId === node.__stxId);
          if (at !== -1)
            record.children.splice(at, 1);
        }
        removeFromBindingParent(node);
        node.__stxOwner = null;
        if (isBindingNode(node)) {
          node.parentNode = null;
          node.parentElement = null;
        }
        setConnected(node, false);
        releaseHandlers(node);
        retainDetachedDescriptors(node);
        if (node.__stxAnchor !== undefined || !wasMaterialized)
          return;
        emit({ op: "removeNode", id: node.__stxId });
      }
    };
  }

  // node_modules/@stacksjs/stx/dist/native/runtime/shared-screen.js
  function prepareSharedNativeScreen(document2, manifest, bridge, options = {}) {
    let revision = 0;
    const protocol = new STXBridge;
    protocol.initialize(bridge);
    installCraftBridge(protocol, bridge, globalThis, options);
    const host = createNativeHost({
      colorScheme: bridge.colorScheme === "dark" ? "dark" : "light",
      send(operations) {
        const baseRevision = revision;
        revision++;
        protocol.mutate({
          version: 1,
          batchId: `mutation_${revision}`,
          baseRevision,
          revision,
          operations
        });
      }
    });
    protocol.on("APPEARANCE", (message) => {
      const scheme = message.payload?.colorScheme;
      if (scheme === "light" || scheme === "dark") {
        bridge.colorScheme = scheme;
        host.setColorScheme(scheme);
      }
    });
    const tree = materializeNativeBindingTree(document2, manifest, host);
    let dispose = null;
    protocol.on("EVENT", (message) => {
      const handlerId = message.payload?.handlerId ?? message.payload?.handlerName;
      if (typeof handlerId === "string")
        host.dispatch(handlerId, message.payload?.nativeEvent);
    });
    return {
      host,
      mount(runtime, setup) {
        dispose?.();
        protocol.render(document2.root);
        dispose = runtime.hydrateHost(tree.root, setup, manifest, tree.nodes);
      },
      unmount() {
        dispose?.();
        dispose = null;
        protocol.dispose("screen-closed");
      }
    };
  }

  // stx-native-shared-screens:entry
  var g = globalThis;
  installJSCGlobals(g);
  var bridge = g.__stxNativeBridge;
  if (!bridge)
    throw new Error("Missing __stxNativeBridge");
  var routeNames = ["manual", "activity", "records", "notifications", "leaderboard", "zzprobe"];
  var routeName = g.__stxNativeRoute || "manual";
  if (routeNames.indexOf(routeName) === -1)
    throw new Error(["Unknown native screen:", routeName].join(" "));
  g.__stxNativeRoute = routeName;
  var nativeDocument;
  var manifest;
  if (routeName === "manual") {
    nativeDocument = { version: "1.0.0", root: { type: "SafeAreaView", props: { "data-stx": "__stx_setup_7d894gptpr" }, style: { flex: 1, flexGrow: 1, flexShrink: 1, flexBasis: 0, backgroundColor: "#020617" }, events: {}, children: [{ type: "ScrollView", props: { testID: "manual-scroll" }, style: { padding: 16 }, events: {}, children: [{ type: "Text", props: {}, style: { fontSize: 30, fontWeight: "bold", color: "#ffffff" }, events: {}, children: ["Log an activity"], _inlineStyle: {}, _classes: "text-3xl font-bold text-white" }, { type: "Text", props: {}, style: { marginTop: 4, fontSize: 14, color: "#94a3b8" }, events: {}, children: ["The same manual entry saved by the Wildloop web feed."], _inlineStyle: {}, _classes: "mt-1 text-sm text-slate-400" }, { type: "View", props: {}, style: { marginTop: 20, gap: 8 }, events: {}, children: [{ type: "Text", props: {}, style: { fontSize: 14, fontWeight: "600", color: "#e2e8f0" }, events: {}, children: ["Activity"], _inlineStyle: {}, _classes: "text-sm font-semibold text-slate-200" }, { type: "Text", props: { "data-stx-parent-bindings": "text", testID: "activity-type" }, style: { fontSize: 18, color: "#6ee7b7" }, events: {}, children: [], _inlineStyle: {}, bindingId: 0, _classes: "text-lg text-emerald-300", bindings: { text: "types[typeIndex()]" } }, { type: "Button", props: { "data-stx-parent-events": "click", type: "button", testID: "cycle-type" }, style: {}, events: { onPress: "cycleType()" }, children: ["Change activity type"], _inlineStyle: {}, bindingId: 1 }], _inlineStyle: {}, _classes: "mt-5 gap-2" }, { type: "View", props: {}, style: { marginTop: 16, gap: 8 }, events: {}, children: [{ type: "Text", props: {}, style: { fontSize: 14, color: "#e2e8f0" }, events: {}, children: ["Distance (miles)"], _inlineStyle: {}, _classes: "text-sm text-slate-200" }, { type: "TextInput", props: { "data-stx-parent-bindings": "value", "data-stx-parent-events": "input", testID: "distance-input", placeholder: 5 }, style: {}, events: { onChangeText: "distance.set(eventText($event))" }, children: [], _inlineStyle: {}, bindingId: 2, bindings: { value: "distance" } }, { type: "Text", props: {}, style: { fontSize: 14, color: "#e2e8f0" }, events: {}, children: ["Duration (MM:SS or H:MM:SS)"], _inlineStyle: {}, _classes: "text-sm text-slate-200" }, { type: "TextInput", props: { "data-stx-parent-bindings": "value", "data-stx-parent-events": "input", testID: "duration-input", placeholder: "45:30" }, style: {}, events: { onChangeText: "duration.set(eventText($event))" }, children: [], _inlineStyle: {}, bindingId: 3, bindings: { value: "duration" } }, { type: "Text", props: {}, style: { fontSize: 14, color: "#e2e8f0" }, events: {}, children: ["Elevation gain (feet)"], _inlineStyle: {}, _classes: "text-sm text-slate-200" }, { type: "TextInput", props: { "data-stx-parent-bindings": "value", "data-stx-parent-events": "input", testID: "elevation-input", placeholder: 800 }, style: {}, events: { onChangeText: "elevation.set(eventText($event))" }, children: [], _inlineStyle: {}, bindingId: 4, bindings: { value: "elevation" } }, { type: "Text", props: {}, style: { fontSize: 14, color: "#e2e8f0" }, events: {}, children: ["Trail id (optional)"], _inlineStyle: {}, _classes: "text-sm text-slate-200" }, { type: "TextInput", props: { "data-stx-parent-bindings": "value", "data-stx-parent-events": "input", testID: "trail-input", placeholder: 42 }, style: {}, events: { onChangeText: "trailId.set(eventText($event))" }, children: [], _inlineStyle: {}, bindingId: 5, bindings: { value: "trailId" } }, { type: "Text", props: {}, style: { fontSize: 14, color: "#e2e8f0" }, events: {}, children: ["Date"], _inlineStyle: {}, _classes: "text-sm text-slate-200" }, { type: "TextInput", props: { "data-stx-parent-events": "input", value: "function ea(){return new Xo}", testID: "date-input", placeholder: "YYYY-MM-DD" }, style: {}, events: { onChangeText: "date.set(eventText($event))" }, children: [], _inlineStyle: {}, bindingId: 6 }, { type: "Text", props: {}, style: { fontSize: 14, color: "#e2e8f0" }, events: {}, children: ["Notes"], _inlineStyle: {}, _classes: "text-sm text-slate-200" }, { type: "TextInput", props: { "data-stx-parent-bindings": "value", "data-stx-parent-events": "input", testID: "notes-input", placeholder: "How did it go?" }, style: {}, events: { onChangeText: "notes.set(eventText($event))" }, children: [], _inlineStyle: {}, bindingId: 7, bindings: { value: "notes" } }], _inlineStyle: {}, _classes: "mt-4 gap-2" }, { type: "View", props: {}, style: { marginTop: 16, gap: 8 }, events: {}, children: [{ type: "Text", props: { "data-stx-parent-bindings": "text", testID: "visibility" }, style: { fontSize: 14, color: "#cbd5e1" }, events: {}, children: [], _inlineStyle: {}, bindingId: 8, _classes: "text-sm text-slate-300", bindings: { text: "'Visible to ' + visibilities[visibilityIndex()]" } }, { type: "Button", props: { "data-stx-parent-events": "click", type: "button", testID: "cycle-visibility" }, style: {}, events: { onPress: "cycleVisibility()" }, children: ["Change visibility"], _inlineStyle: {}, bindingId: 9 }], _inlineStyle: {}, _classes: "mt-4 gap-2" }, { type: "View", props: {}, style: { marginTop: 20, gap: 8 }, events: {}, children: [{ type: "View", props: { label: "Distance", testID: "distance-preview" }, style: { borderRadius: 12, backgroundColor: "#022c22", padding: 12 }, events: {}, children: [{ type: "Text", props: {}, style: { fontSize: 12, color: "#6ee7b7" }, events: {}, children: ["Distance"], _inlineStyle: {}, _classes: "text-xs text-emerald-300" }, { type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 20, fontWeight: "bold", color: "#ffffff" }, events: {}, children: [], _inlineStyle: {}, bindingId: 10, _classes: "text-xl font-bold text-white", bindings: { text: "distance() ? distance() + ' mi' : '--'" } }], _inlineStyle: {}, _classes: "rounded-xl bg-emerald-950 p-3" }, { type: "View", props: { label: "Duration", testID: "duration-preview" }, style: { borderRadius: 12, backgroundColor: "#022c22", padding: 12 }, events: {}, children: [{ type: "Text", props: {}, style: { fontSize: 12, color: "#6ee7b7" }, events: {}, children: ["Duration"], _inlineStyle: {}, _classes: "text-xs text-emerald-300" }, { type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 20, fontWeight: "bold", color: "#ffffff" }, events: {}, children: [], _inlineStyle: {}, bindingId: 11, _classes: "text-xl font-bold text-white", bindings: { text: "duration() || '--'" } }], _inlineStyle: {}, _classes: "rounded-xl bg-emerald-950 p-3" }], _inlineStyle: {}, _classes: "mt-5 gap-2" }, { type: "Text", props: { "data-stx-parent-bindings": "text", testID: "manual-error" }, style: { marginTop: 16, color: "#fda4af" }, events: {}, children: [], _inlineStyle: {}, bindingId: 13, _classes: "mt-4 text-rose-300", bindings: { if: "error", text: "error" } }, { type: "Button", props: { "data-stx-parent-events": "click", type: "button", testID: "save-activity" }, style: { marginTop: 20 }, events: { onPress: "submit()" }, children: ["Save activity"], _inlineStyle: {}, bindingId: 14, _classes: "mt-5" }, { type: "Button", props: { "data-stx-parent-events": "click", type: "button", testID: "manual-back" }, style: { marginTop: 8 }, events: { onPress: "goBack()" }, children: ["Back"], _inlineStyle: {}, bindingId: 15, _classes: "mt-2" }], _inlineStyle: {}, _classes: "p-4" }], _inlineStyle: {}, _classes: "flex-1 bg-slate-950" }, script: { exports: {}, functions: ["eventText", "cycleType", "cycleVisibility", "goBack", "messageFrom", "submit"], code: `import type { NativeCraft } from '@stacksjs/stx/native'
import { ACTIVITY_VISIBILITIES, buildManualActivity, MANUAL_ACTIVITY_TYPES, todayLocal } from '../functions/manual-activity'

const craft = (globalThis as typeof globalThis & { craft: NativeCraft }).craft
const types = [...MANUAL_ACTIVITY_TYPES]
const visibilities = [...ACTIVITY_VISIBILITIES]

const typeIndex = state(0)
const visibilityIndex = state(1)
const distance = state('')
const duration = state('')
const elevation = state('')
const trailId = state('')
const date = state(todayLocal())
const notes = state('')
const saving = state(false)
const error = state('')
let active = true

function eventText(event: { text?: unknown }): string {
  return event?.text == null ? '' : String(event.text)
}

function cycleType() {
  typeIndex.set((typeIndex() + 1) % types.length)
}

function cycleVisibility() {
  visibilityIndex.set((visibilityIndex() + 1) % visibilities.length)
}

function goBack() {
  craft.navigation.back()
}

async function messageFrom(response: Response, fallback: string): Promise<{ body: any, message: string }> {
  const body = await response.json().catch(() => null)
  const fields = body?.fields ?? body?.errors
  const message = fields && typeof fields === 'object'
    ? Object.values(fields).map(String).join(' ')
    : String(body?.message ?? fallback)
  return { body, message }
}

async function submit() {
  if (saving()) return
  const built = buildManualActivity({
    type: types[typeIndex()],
    distance: distance(),
    duration: duration(),
    elevation: elevation(),
    trailId: trailId(),
    date: date(),
    notes: notes(),
    visibility: visibilities[visibilityIndex()],
    // No id: the token below is the only identity this screen has, and the API
    // takes the actor from the session regardless. Reading one from
    // \`route.params\` refused a save on a cold start, where \`initialScreen\`
    // passes no params — with a valid token sitting in secureStorage.
  }, null)
  if (built.ok === false) {
    error.set(built.error)
    return
  }

  saving.set(true)
  error.set('')
  try {
    const token = await craft.secureStorage.get('auth_token')
    if (!token) throw new Error('Sign in before saving an activity')
    const response = await fetch('https://wildloop.org/api/activities', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: \`Bearer \${token}\`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(built.payload),
    })
    const result = await messageFrom(response, 'Could not save the activity')
    if (!response.ok) throw new Error(result.message)
    const created = result.body?.activity
    if (!created?.id) throw new Error('Wildloop did not return the saved activity')
    if (!active) return
    await craft.haptics.notification('success')
    if (!active) return
    craft.navigation.push('activity', {
      id: created.id,
      // The server's answer, not a guess carried in from the route.
      userId: created.userId ?? 0,
      activityType: built.payload.activity_type,
      distance: built.payload.distance,
      duration: built.payload.duration,
      pace: built.payload.pace,
      elevation: built.payload.elevation,
      completedAt: built.payload.completed_at,
    })
  }
  catch (cause) {
    if (active) error.set(cause instanceof Error ? cause.message : 'Could not save the activity')
  }
  finally {
    if (active) saving.set(false)
  }
}

onMount(() => {
  craft.navigation.setOptions({ title: 'Log activity', largeTitle: true })
})
onDestroy(() => {
  active = false
})` }, meta: { source: "/Users/glennmichaeltorregosa/Documents/Stacks/wildloop/resources/native/ManualActivity.stx", compiledAt: 1791898294680 } };
    manifest = { entries: [{ id: 0, bindings: [{ name: ":text", value: "types[typeIndex()]", kind: "text" }] }, { id: 1, bindings: [{ name: "@click", value: "cycleType()", kind: "event" }] }, { id: 2, bindings: [{ name: ":value", value: "distance", kind: "attr" }, { name: "@input", value: "distance.set(eventText($event))", kind: "event" }] }, { id: 3, bindings: [{ name: ":value", value: "duration", kind: "attr" }, { name: "@input", value: "duration.set(eventText($event))", kind: "event" }] }, { id: 4, bindings: [{ name: ":value", value: "elevation", kind: "attr" }, { name: "@input", value: "elevation.set(eventText($event))", kind: "event" }] }, { id: 5, bindings: [{ name: ":value", value: "trailId", kind: "attr" }, { name: "@input", value: "trailId.set(eventText($event))", kind: "event" }] }, { id: 6, bindings: [{ name: "@input", value: "date.set(eventText($event))", kind: "event" }] }, { id: 7, bindings: [{ name: ":value", value: "notes", kind: "attr" }, { name: "@input", value: "notes.set(eventText($event))", kind: "event" }] }, { id: 8, bindings: [{ name: ":text", value: "'Visible to ' + visibilities[visibilityIndex()]", kind: "text" }] }, { id: 9, bindings: [{ name: "@click", value: "cycleVisibility()", kind: "event" }] }, { id: 10, bindings: [{ name: ":text", value: "distance() ? distance() + ' mi' : '--'", kind: "text" }] }, { id: 11, bindings: [{ name: ":text", value: "duration() || '--'", kind: "text" }] }, { id: 12, bindings: [{ name: ":if", value: "error", kind: "if" }] }, { id: 13, bindings: [{ name: ":text", value: "error", kind: "text" }] }, { id: 14, bindings: [{ name: "@click", value: "submit()", kind: "event" }] }, { id: 15, bindings: [{ name: "@click", value: "goBack()", kind: "event" }] }] };
  } else if (routeName === "activity") {
    nativeDocument = { version: "1.0.0", root: { type: "SafeAreaView", props: { "data-stx": "__stx_setup_2u0xf7j4l1" }, style: { flex: 1, flexGrow: 1, flexShrink: 1, flexBasis: 0, backgroundColor: "#020617", padding: 16 }, events: {}, children: [{ type: "Text", props: { "data-stx-parent-bindings": "text", testID: "saved-title" }, style: { fontSize: 30, fontWeight: "bold", color: "#ffffff" }, events: {}, children: [], _inlineStyle: {}, bindingId: 0, _classes: "text-3xl font-bold text-white", bindings: { text: "activityType() + ' saved'" } }, { type: "Text", props: { text: "Wildloop activity #[object Promise]", testID: "saved-id" }, style: { marginTop: 4, fontSize: 14, color: "#94a3b8" }, events: {}, children: [], _inlineStyle: {}, _classes: "mt-1 text-sm text-slate-400" }, { type: "View", props: {}, style: { marginTop: 20, gap: 8 }, events: {}, children: [{ type: "View", props: { label: "Distance", testID: "saved-distance" }, style: { borderRadius: 12, backgroundColor: "#022c22", padding: 12 }, events: {}, children: [{ type: "Text", props: {}, style: { fontSize: 12, color: "#6ee7b7" }, events: {}, children: ["Distance"], _inlineStyle: {}, _classes: "text-xs text-emerald-300" }, { type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 20, fontWeight: "bold", color: "#ffffff" }, events: {}, children: [], _inlineStyle: {}, bindingId: 1, _classes: "text-xl font-bold text-white", bindings: { text: "distance() + ' mi'" } }], _inlineStyle: {}, _classes: "rounded-xl bg-emerald-950 p-3" }, { type: "View", props: { label: "Duration", testID: "saved-duration" }, style: { borderRadius: 12, backgroundColor: "#022c22", padding: 12 }, events: {}, children: [{ type: "Text", props: {}, style: { fontSize: 12, color: "#6ee7b7" }, events: {}, children: ["Duration"], _inlineStyle: {}, _classes: "text-xs text-emerald-300" }, { type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 20, fontWeight: "bold", color: "#ffffff" }, events: {}, children: [], _inlineStyle: {}, bindingId: 2, _classes: "text-xl font-bold text-white", bindings: { text: "duration" } }], _inlineStyle: {}, _classes: "rounded-xl bg-emerald-950 p-3" }, { type: "View", props: { label: "Pace", testID: "saved-pace" }, style: { borderRadius: 12, backgroundColor: "#022c22", padding: 12 }, events: {}, children: [{ type: "Text", props: {}, style: { fontSize: 12, color: "#6ee7b7" }, events: {}, children: ["Pace"], _inlineStyle: {}, _classes: "text-xs text-emerald-300" }, { type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 20, fontWeight: "bold", color: "#ffffff" }, events: {}, children: [], _inlineStyle: {}, bindingId: 3, _classes: "text-xl font-bold text-white", bindings: { text: "pace" } }], _inlineStyle: {}, _classes: "rounded-xl bg-emerald-950 p-3" }, { type: "View", props: { label: "Elevation", testID: "saved-elevation" }, style: { borderRadius: 12, backgroundColor: "#022c22", padding: 12 }, events: {}, children: [{ type: "Text", props: {}, style: { fontSize: 12, color: "#6ee7b7" }, events: {}, children: ["Elevation"], _inlineStyle: {}, _classes: "text-xs text-emerald-300" }, { type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 20, fontWeight: "bold", color: "#ffffff" }, events: {}, children: [], _inlineStyle: {}, bindingId: 4, _classes: "text-xl font-bold text-white", bindings: { text: "elevation() + ' ft'" } }], _inlineStyle: {}, _classes: "rounded-xl bg-emerald-950 p-3" }], _inlineStyle: {}, _classes: "mt-5 gap-2" }, { type: "Button", props: { "data-stx-parent-events": "click", type: "button", testID: "activity-back" }, style: { marginTop: 20 }, events: { onPress: "goBack()" }, children: ["Back to feed"], _inlineStyle: {}, bindingId: 5, _classes: "mt-5" }, { type: "Button", props: { "data-stx-parent-events": "click", type: "button", testID: "log-another" }, style: { marginTop: 8 }, events: { onPress: "logAnother()" }, children: ["Log another"], _inlineStyle: {}, bindingId: 6, _classes: "mt-2" }], _inlineStyle: {}, _classes: "flex-1 bg-slate-950 p-4" }, script: { exports: {}, functions: ["goBack", "logAnother"], code: `import type { NativeCraft } from '@stacksjs/stx/native'

const craft = (globalThis as typeof globalThis & { craft: NativeCraft }).craft
const params = craft.route.params
const id = state(String(params.id ?? ''))
const userId = Number(params.userId ?? 0)
const activityType = state(String(params.activityType ?? 'Activity'))
const distance = state(Number(params.distance ?? 0))
const duration = state(String(params.duration ?? '--'))
const pace = state(String(params.pace ?? '--'))
const elevation = state(Number(params.elevation ?? 0))

function goBack() {
  craft.navigation.back()
}

function logAnother() {
  craft.navigation.replace('manual', { userId })
}

onMount(() => {
  craft.navigation.setOptions({ title: 'Activity saved', largeTitle: false })
})` }, meta: { source: "/Users/glennmichaeltorregosa/Documents/Stacks/wildloop/resources/native/ActivitySaved.stx", compiledAt: 1791898294702 } };
    manifest = { entries: [{ id: 0, bindings: [{ name: ":text", value: "activityType() + ' saved'", kind: "text" }] }, { id: 1, bindings: [{ name: ":text", value: "distance() + ' mi'", kind: "text" }] }, { id: 2, bindings: [{ name: ":text", value: "duration", kind: "text" }] }, { id: 3, bindings: [{ name: ":text", value: "pace", kind: "text" }] }, { id: 4, bindings: [{ name: ":text", value: "elevation() + ' ft'", kind: "text" }] }, { id: 5, bindings: [{ name: "@click", value: "goBack()", kind: "event" }] }, { id: 6, bindings: [{ name: "@click", value: "logAnother()", kind: "event" }] }] };
  } else if (routeName === "records") {
    nativeDocument = { version: "1.0.0", root: { type: "SafeAreaView", props: { "data-stx": "__stx_setup_3mxivmfhgr" }, style: { flex: 1, flexGrow: 1, flexShrink: 1, flexBasis: 0, backgroundColor: "#020617" }, events: {}, children: [{ type: "ScrollView", props: { testID: "records-scroll" }, style: { padding: 16 }, events: {}, children: [{ type: "Text", props: {}, style: { fontSize: 30, fontWeight: "bold", color: "#ffffff" }, events: {}, children: ["Fastest known times"], _inlineStyle: {}, _classes: "text-3xl font-bold text-white" }, { type: "Text", props: {}, style: { marginTop: 4, fontSize: 14, color: "#94a3b8" }, events: {}, children: ["Verified and pending claims across the catalog."], _inlineStyle: {}, _classes: "mt-1 text-sm text-slate-400" }, { type: "View", props: {}, style: { marginTop: 16, gap: 8 }, events: {}, children: [{ type: "Text", props: { "data-stx-parent-bindings": "text", testID: "style-filter" }, style: { fontSize: 14, color: "#cbd5e1" }, events: {}, children: [], _inlineStyle: {}, bindingId: 0, _classes: "text-sm text-slate-300", bindings: { text: "styleLabel()" } }, { type: "Button", props: { "data-stx-parent-events": "click", type: "button", testID: "cycle-style" }, style: {}, events: { onPress: "cycleStyle()" }, children: ["Change style"], _inlineStyle: {}, bindingId: 1 }], _inlineStyle: {}, _classes: "mt-4 gap-2" }, { type: "ActivityIndicator", props: { testID: "records-loading", role: "status" }, style: { marginTop: 24 }, events: {}, children: [], _inlineStyle: {}, _classes: "mt-6", bindings: { if: "loading" }, bindingId: 2 }, { type: "Text", props: { "data-stx-parent-bindings": "text", testID: "records-error" }, style: { marginTop: 16, color: "#fda4af" }, events: {}, children: [], _inlineStyle: {}, bindingId: 4, _classes: "mt-4 text-rose-300", bindings: { if: "error", text: "error" } }, { type: "View", props: { testID: "records-list" }, style: { marginTop: 20, gap: 12 }, events: {}, children: [{ type: "Pressable", props: { "data-stx-parent-bindings": "key", "data-stx-parent-events": "click", testID: "record-row", role: "button" }, style: { borderRadius: 12, backgroundColor: "#0f172a", padding: 12 }, events: { onPress: "openEffort(row.id)" }, children: [{ type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 16, fontWeight: "600", color: "#ffffff" }, events: {}, children: [], _inlineStyle: {}, bindingId: 7, _classes: "text-base font-semibold text-white", bindings: { text: "row.trailName" } }, { type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 12, color: "#94a3b8" }, events: {}, children: [], _inlineStyle: {}, bindingId: 9, _classes: "text-xs text-slate-400", bindings: { if: "row.where", text: "row.where" } }, { type: "View", props: {}, style: { marginTop: 8, flexDirection: "row", alignItems: "baseline", gap: 8 }, events: {}, children: [{ type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 20, fontWeight: "bold", color: "#6ee7b7" }, events: {}, children: [], _inlineStyle: {}, bindingId: 10, _classes: "text-xl font-bold text-emerald-300", bindings: { text: "row.elapsed" } }, { type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 12, color: "#94a3b8" }, events: {}, children: [], _inlineStyle: {}, bindingId: 12, _classes: "text-xs text-slate-400", bindings: { if: "row.pace", text: "row.pace" } }], _inlineStyle: {}, _classes: "mt-2 flex-row items-baseline gap-2" }, { type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { marginTop: 4, fontSize: 12, color: "#cbd5e1" }, events: {}, children: [], _inlineStyle: {}, bindingId: 13, _classes: "mt-1 text-xs text-slate-300", bindings: { text: "row.who + ' · ' + row.kind" } }, { type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 12, color: "#64748b" }, events: {}, children: [], _inlineStyle: {}, bindingId: 14, _classes: "text-xs text-slate-500", bindings: { text: "row.status" } }], _inlineStyle: {}, bindingId: 6, _classes: "rounded-xl bg-slate-900 p-3", bindings: { for: "row in rows()", key: "row.id" } }], _inlineStyle: {}, _classes: "mt-5 gap-3" }, { type: "Text", props: { testID: "records-empty" }, style: { marginTop: 24, fontSize: 14, color: "#94a3b8" }, events: {}, children: ["No claims match this style yet."], _inlineStyle: {}, _classes: "mt-6 text-sm text-slate-400", bindings: { if: "!loading && !error && rows().length === 0" }, bindingId: 15 }], _inlineStyle: {}, _classes: "p-4" }], _inlineStyle: {}, _classes: "flex-1 bg-slate-950" }, script: { exports: {}, functions: ["styleLabel", "rowFrom", "load", "cycleStyle", "openEffort"], code: `import type { NativeCraft } from '@stacksjs/stx/native'
import {
  CATEGORY_LABELS,
  formatElapsed,
  RECORD_STYLES,
  recordPace,
  STATUS_LABELS,
  STYLE_LABELS,
} from '../functions/route-records'

/*
 * Fastest known times, as a native screen.
 *
 * The first promotion that is a list rather than a form, so it is the one that
 * exercises a keyed \`:for\` over the shared mutation protocol. Everything
 * it computes — the labels, the elapsed time, the pace — comes from
 * \`resources/functions/route-records.ts\`, the same module the web screen reads
 * through \`useRouteRecords\`. The two screens diverge on presentation and must
 * never diverge on a number.
 *
 * The board is public, so no token: \`/api/route-efforts\` answers 200 to anyone,
 * which is also why the web page is crawlable. A row hands off to the web
 * screen through \`craft.navigation.open\` rather than reimplementing an effort
 * page that needs a map (craft-native/craft#340).
 */

const craft = (globalThis as typeof globalThis & { craft: NativeCraft }).craft

interface RecordRow {
  id: number
  trailId: number
  trailName: string
  where: string
  who: string
  elapsed: string
  pace: string
  status: string
  kind: string
}

const STYLE_CHOICES = ['all', ...RECORD_STYLES] as const

const styleIndex = state(0)
const rows = state<RecordRow[]>([])
const loading = state(true)
const error = state('')
let active = true

function styleLabel(): string {
  const choice = STYLE_CHOICES[styleIndex()]
  return choice === 'all' ? 'Every style' : STYLE_LABELS[choice]
}

/** One API effort as the row this screen draws. Shared helpers, no local maths. */
function rowFrom(effort: any): RecordRow {
  const miles = Number(effort?.trailDistance) || 0
  const seconds = effort?.elapsedSeconds == null ? null : Number(effort.elapsedSeconds)
  return {
    id: Number(effort?.id) || 0,
    trailId: Number(effort?.trailId) || 0,
    trailName: String(effort?.trailName ?? 'Unnamed trail'),
    where: String(effort?.trailLocation ?? ''),
    who: String(effort?.userName ?? 'Someone'),
    elapsed: formatElapsed(seconds),
    pace: miles > 0 && seconds ? recordPace(miles, seconds) : '',
    status: STATUS_LABELS[effort?.status as keyof typeof STATUS_LABELS] ?? String(effort?.status ?? ''),
    kind: [
      STYLE_LABELS[effort?.style as keyof typeof STYLE_LABELS] ?? '',
      CATEGORY_LABELS[effort?.category as keyof typeof CATEGORY_LABELS] ?? '',
    ].filter(Boolean).join(' · '),
  }
}

async function load(): Promise<void> {
  loading.set(true)
  error.set('')
  const choice = STYLE_CHOICES[styleIndex()]
  const query = choice === 'all' ? 'limit=40' : \`limit=40&style=\${choice}\`
  try {
    const response = await fetch(\`https://wildloop.org/api/route-efforts?\${query}\`, {
      headers: { Accept: 'application/json' },
    })
    const body = await response.json().catch(() => null)
    if (!active)
      return
    if (!response.ok || !Array.isArray(body?.efforts))
      throw new Error('Could not reach the records service')
    rows.set(body.efforts.map(rowFrom))
  }
  catch (cause) {
    if (active)
      error.set(cause instanceof Error ? cause.message : 'Could not reach the records service')
  }
  finally {
    if (active)
      loading.set(false)
  }
}

function cycleStyle(): void {
  styleIndex.set((styleIndex() + 1) % STYLE_CHOICES.length)
  void load()
}

/*
 * An effort's own page is a map screen, so it stays on the web side for now and
 * the native list hands off to it. One warm web view, one navigation stack.
 */
function openEffort(id: number): void {
  craft.navigation.open(\`/effort/\${id}\`)
}

onMount(() => {
  craft.navigation.setOptions({ title: 'Records', largeTitle: true })
  // A first frame from whatever the web screen last saw, so the list is not
  // empty while the request is in flight. Absent on a cold install.
  const cached = craft.snapshots.get<any[]>('records')
  if (Array.isArray(cached) && cached.length > 0) {
    rows.set(cached.map(rowFrom))
    loading.set(false)
  }
  void load()
})

onDestroy(() => {
  active = false
})` }, meta: { source: "/Users/glennmichaeltorregosa/Documents/Stacks/wildloop/resources/native/Records.stx", compiledAt: 1791898294730 } };
    manifest = { entries: [{ id: 0, bindings: [{ name: ":text", value: "styleLabel()", kind: "text" }] }, { id: 1, bindings: [{ name: "@click", value: "cycleStyle()", kind: "event" }] }, { id: 2, bindings: [{ name: ":if", value: "loading", kind: "if" }] }, { id: 3, bindings: [{ name: ":if", value: "error", kind: "if" }] }, { id: 4, bindings: [{ name: ":text", value: "error", kind: "text" }] }, { id: 5, bindings: [{ name: ":for", value: "row in rows()", kind: "for" }], template: true }, { id: 6, bindings: [{ name: ":key", value: "row.id", kind: "attr" }, { name: "@click", value: "openEffort(row.id)", kind: "event" }] }, { id: 7, bindings: [{ name: ":text", value: "row.trailName", kind: "text" }] }, { id: 8, bindings: [{ name: ":if", value: "row.where", kind: "if" }] }, { id: 9, bindings: [{ name: ":text", value: "row.where", kind: "text" }] }, { id: 10, bindings: [{ name: ":text", value: "row.elapsed", kind: "text" }] }, { id: 11, bindings: [{ name: ":if", value: "row.pace", kind: "if" }] }, { id: 12, bindings: [{ name: ":text", value: "row.pace", kind: "text" }] }, { id: 13, bindings: [{ name: ":text", value: "row.who + ' · ' + row.kind", kind: "text" }] }, { id: 14, bindings: [{ name: ":text", value: "row.status", kind: "text" }] }, { id: 15, bindings: [{ name: ":if", value: "!loading && !error && rows().length === 0", kind: "if" }] }] };
  } else if (routeName === "notifications") {
    nativeDocument = { version: "1.0.0", root: { type: "SafeAreaView", props: { "data-stx": "__stx_setup_rxae00qm1c" }, style: { flex: 1, flexGrow: 1, flexShrink: 1, flexBasis: 0, backgroundColor: "#020617" }, events: {}, children: [{ type: "ScrollView", props: { testID: "notifications-scroll" }, style: { padding: 16 }, events: {}, children: [{ type: "Text", props: {}, style: { fontSize: 30, fontWeight: "bold", color: "#ffffff" }, events: {}, children: ["Notifications"], _inlineStyle: {}, _classes: "text-3xl font-bold text-white" }, { type: "Text", props: { "data-stx-parent-bindings": "text", testID: "unread-count" }, style: { marginTop: 4, fontSize: 14, color: "#94a3b8" }, events: {}, children: [], _inlineStyle: {}, bindingId: 0, _classes: "mt-1 text-sm text-slate-400", bindings: { text: "unread() > 0 ? unread() + ' unread' : 'All caught up'" } }, { type: "View", props: {}, style: { marginTop: 16, gap: 8 }, events: {}, children: [{ type: "Text", props: { "data-stx-parent-bindings": "text", testID: "filter-label" }, style: { fontSize: 14, color: "#cbd5e1" }, events: {}, children: [], _inlineStyle: {}, bindingId: 1, _classes: "text-sm text-slate-300", bindings: { text: "filterLabel()" } }, { type: "Button", props: { "data-stx-parent-events": "click", type: "button", testID: "cycle-filter" }, style: {}, events: { onPress: "cycleFilter()" }, children: ["Change filter"], _inlineStyle: {}, bindingId: 2 }, { type: "Button", props: { "data-stx-parent-events": "click", type: "button", testID: "mark-all" }, style: {}, events: { onPress: "markAllRead()" }, children: ["Mark all read"], _inlineStyle: {}, bindingId: 3 }], _inlineStyle: {}, _classes: "mt-4 gap-2" }, { type: "ActivityIndicator", props: { testID: "notifications-loading", role: "status" }, style: { marginTop: 24 }, events: {}, children: [], _inlineStyle: {}, _classes: "mt-6", bindings: { if: "loading" }, bindingId: 4 }, { type: "Text", props: { "data-stx-parent-bindings": "text", testID: "notifications-error" }, style: { marginTop: 16, color: "#fda4af" }, events: {}, children: [], _inlineStyle: {}, bindingId: 6, _classes: "mt-4 text-rose-300", bindings: { if: "error", text: "error" } }, { type: "Text", props: { testID: "notifications-signed-out" }, style: { marginTop: 16, fontSize: 14, color: "#94a3b8" }, events: {}, children: ["Sign in to hear when somebody gives you kudos, challenges you, or takes your ground."], _inlineStyle: {}, _classes: "mt-4 text-sm text-slate-400", bindings: { if: "signedOut" }, bindingId: 7 }, { type: "View", props: { testID: "notifications-list" }, style: { marginTop: 20, gap: 20 }, events: {}, children: [{ type: "View", props: { "data-stx-parent-bindings": "key" }, style: { gap: 8 }, events: {}, children: [{ type: "Text", props: { "data-stx-parent-bindings": "text", testID: "day-heading" }, style: { fontSize: 12, fontWeight: "600", textTransform: "uppercase", color: "#64748b" }, events: {}, children: [], _inlineStyle: {}, bindingId: 10, _classes: "text-xs font-semibold uppercase text-slate-500", bindings: { text: "day.label" } }, { type: "Pressable", props: { "data-stx-parent-bindings": "key", "data-stx-parent-events": "click", testID: "notification-row", role: "button" }, style: { borderRadius: 12, backgroundColor: "#0f172a", padding: 12 }, events: { onPress: "openRow(row)" }, children: [{ type: "View", props: {}, style: { flexDirection: "row", alignItems: "baseline", gap: 8 }, events: {}, children: [{ type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 16, fontWeight: "600", color: "#ffffff" }, events: {}, children: [], _inlineStyle: {}, bindingId: 13, _classes: "text-base font-semibold text-white", bindings: { text: "row.title" } }, { type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 12, color: "#64748b" }, events: {}, children: [], _inlineStyle: {}, bindingId: 14, _classes: "text-xs text-slate-500", bindings: { text: "timeAgo(row.created_at)" } }], _inlineStyle: {}, _classes: "flex-row items-baseline gap-2" }, { type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { marginTop: 4, fontSize: 14, color: "#cbd5e1" }, events: {}, children: [], _inlineStyle: {}, bindingId: 15, _classes: "mt-1 text-sm text-slate-300", bindings: { text: "row.message" } }, { type: "Text", props: { testID: "row-unread" }, style: { marginTop: 4, fontSize: 12, color: "#6ee7b7" }, events: {}, children: ["New"], _inlineStyle: {}, _classes: "mt-1 text-xs text-emerald-300", bindings: { if: "!row.read" }, bindingId: 16 }], _inlineStyle: {}, bindingId: 12, _classes: "rounded-xl bg-slate-900 p-3", bindings: { for: "row in day.items", key: "row.id" } }], _inlineStyle: {}, bindingId: 9, _classes: "gap-2", bindings: { for: "day in sections()", key: "day.label" } }], _inlineStyle: {}, _classes: "mt-5 gap-5" }, { type: "Text", props: { testID: "notifications-empty" }, style: { marginTop: 24, fontSize: 14, color: "#94a3b8" }, events: {}, children: ["Nothing under this filter."], _inlineStyle: {}, _classes: "mt-6 text-sm text-slate-400", bindings: { if: "!loading && !error && !signedOut && sections().length === 0" }, bindingId: 17 }], _inlineStyle: {}, _classes: "p-4" }], _inlineStyle: {}, _classes: "flex-1 bg-slate-950" }, script: { exports: {}, functions: ["filterLabel", "sections", "unread", "readToken", "load", "cycleFilter", "markAllRead", "openRow"], code: `import type { NativeCraft } from '@stacksjs/stx/native'
import {
  groupNotificationsByDay,
  matchesNotificationFilter,
  NOTIFICATION_FILTERS,
  notificationRowsFrom,
  timeAgo,
} from '../functions/notifications'

/*
 * Notifications, natively.
 *
 * The second list screen, and the first that reads something only the signed-in
 * athlete can see — so unlike the records board this one needs the token, and
 * unlike the manual entry form it also writes (marking read). Which alerts
 * belong under a filter, which day each one sits in, and how long ago it
 * arrived are all decided in \`resources/functions/notifications.ts\`, the module
 * the web page reads too.
 *
 * A row opens the thing it is about on the web side through
 * \`craft.navigation.open\`: a kudos leads to an activity, a conquest to a
 * territory, and both of those screens are built around a map
 * (craft-native/craft#340).
 */

const craft = (globalThis as typeof globalThis & { craft: NativeCraft }).craft

const FILTERS = NOTIFICATION_FILTERS.map(filter => filter.key)

const filterIndex = state(0)
const rows = state<any[]>([])
const loading = state(true)
const error = state('')
const signedOut = state(false)
let active = true

function filterLabel(): string {
  return NOTIFICATION_FILTERS[filterIndex()].label
}

/** The rows under the chosen chip, grouped the way the web page groups them. */
function sections(): any[] {
  const chosen = FILTERS[filterIndex()]
  return groupNotificationsByDay(rows().filter((row: any) => matchesNotificationFilter(row, chosen)))
}

function unread(): number {
  return rows().filter((row: any) => !row.read).length
}

/*
 * Read once and kept: one round trip rather than two for a value that cannot
 * change while the screen is open.
 *
 * Not because a second read fails. It was blamed for a write that hung here,
 * and it is innocent — the bridge gives every request a new id and holds no
 * cache. The hang was a tap that never ran, from an \`:if\` on the button.
 */
const bearer = state('')

async function readToken(): Promise<string> {
  if (bearer())
    return bearer()
  const value = await craft.secureStorage.get('auth_token')
  const token = typeof value === 'string' ? value : ''
  bearer.set(token)
  return token
}

async function load(): Promise<void> {
  loading.set(true)
  error.set('')
  try {
    const token = await readToken()
    if (!token) {
      if (active) {
        signedOut.set(true)
        loading.set(false)
      }
      return
    }
    const response = await fetch('https://wildloop.org/api/notifications', {
      headers: { Accept: 'application/json', Authorization: \`Bearer \${token}\` },
    })
    const body = await response.json().catch(() => null)
    if (!active)
      return
    if (response.status === 401) {
      signedOut.set(true)
      loading.set(false)
      return
    }
    if (!response.ok)
      throw new Error('Could not load your notifications')
    signedOut.set(false)
    rows.set(notificationRowsFrom(body))
  }
  catch (cause) {
    if (active)
      error.set(cause instanceof Error ? cause.message : 'Could not load your notifications')
  }
  finally {
    if (active)
      loading.set(false)
  }
}

function cycleFilter(): void {
  filterIndex.set((filterIndex() + 1) % FILTERS.length)
}

/*
 * Marked read here first and sent afterwards: the badge is the reason somebody
 * opened the screen, and waiting for a round trip to clear it reads as a tap
 * that did nothing. A failed write leaves the list read and the next load
 * corrects it, which is the same bargain the web page makes.
 */
async function markAllRead(): Promise<void> {
  if (unread() === 0)
    return
  rows.set(rows().map((row: any) => ({ ...row, read: true })))
  try {
    const token = await readToken()
    if (!token)
      return
    await fetch('https://wildloop.org/api/notifications/read', {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: \`Bearer \${token}\`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (active)
      await craft.haptics.selection()
  }
  catch {
    // The list is already read; the next load is the correction.
  }
}

function openRow(row: any): void {
  if (!row?.link || row.link === '#')
    return
  craft.navigation.open(String(row.link))
}

onMount(() => {
  craft.navigation.setOptions({ title: 'Notifications', largeTitle: true })
  void load()
})

onDestroy(() => {
  active = false
})` }, meta: { source: "/Users/glennmichaeltorregosa/Documents/Stacks/wildloop/resources/native/Notifications.stx", compiledAt: 1791898294752 } };
    manifest = { entries: [{ id: 0, bindings: [{ name: ":text", value: "unread() > 0 ? unread() + ' unread' : 'All caught up'", kind: "text" }] }, { id: 1, bindings: [{ name: ":text", value: "filterLabel()", kind: "text" }] }, { id: 2, bindings: [{ name: "@click", value: "cycleFilter()", kind: "event" }] }, { id: 3, bindings: [{ name: "@click", value: "markAllRead()", kind: "event" }] }, { id: 4, bindings: [{ name: ":if", value: "loading", kind: "if" }] }, { id: 5, bindings: [{ name: ":if", value: "error", kind: "if" }] }, { id: 6, bindings: [{ name: ":text", value: "error", kind: "text" }] }, { id: 7, bindings: [{ name: ":if", value: "signedOut", kind: "if" }] }, { id: 8, bindings: [{ name: ":for", value: "day in sections()", kind: "for" }], template: true }, { id: 9, bindings: [{ name: ":key", value: "day.label", kind: "attr" }] }, { id: 10, bindings: [{ name: ":text", value: "day.label", kind: "text" }] }, { id: 11, bindings: [{ name: ":for", value: "row in day.items", kind: "for" }], template: true }, { id: 12, bindings: [{ name: ":key", value: "row.id", kind: "attr" }, { name: "@click", value: "openRow(row)", kind: "event" }] }, { id: 13, bindings: [{ name: ":text", value: "row.title", kind: "text" }] }, { id: 14, bindings: [{ name: ":text", value: "timeAgo(row.created_at)", kind: "text" }] }, { id: 15, bindings: [{ name: ":text", value: "row.message", kind: "text" }] }, { id: 16, bindings: [{ name: ":if", value: "!row.read", kind: "if" }] }, { id: 17, bindings: [{ name: ":if", value: "!loading && !error && !signedOut && sections().length === 0", kind: "if" }] }] };
  } else if (routeName === "leaderboard") {
    nativeDocument = { version: "1.0.0", root: { type: "SafeAreaView", props: { "data-stx": "__stx_setup_1ttna6xvbs" }, style: { flex: 1, flexGrow: 1, flexShrink: 1, flexBasis: 0, backgroundColor: "#020617" }, events: {}, children: [{ type: "ScrollView", props: { testID: "leaderboard-scroll" }, style: { padding: 16 }, events: {}, children: [{ type: "Text", props: {}, style: { fontSize: 30, fontWeight: "bold", color: "#ffffff" }, events: {}, children: ["Leaderboard"], _inlineStyle: {}, _classes: "text-3xl font-bold text-white" }, { type: "Text", props: { "data-stx-parent-bindings": "text", testID: "headline" }, style: { marginTop: 4, fontSize: 14, color: "#94a3b8" }, events: {}, children: [], _inlineStyle: {}, bindingId: 0, _classes: "mt-1 text-sm text-slate-400", bindings: { text: "headline()" } }, { type: "View", props: {}, style: { marginTop: 16, gap: 8 }, events: {}, children: [{ type: "Text", props: { "data-stx-parent-bindings": "text", testID: "scope-label" }, style: { fontSize: 14, color: "#cbd5e1" }, events: {}, children: [], _inlineStyle: {}, bindingId: 1, _classes: "text-sm text-slate-300", bindings: { text: "scopeName()" } }, { type: "Button", props: { "data-stx-parent-events": "click", type: "button", testID: "cycle-scope" }, style: {}, events: { onPress: "cycleScope()" }, children: ["Change who is ranked"], _inlineStyle: {}, bindingId: 2 }, { type: "Text", props: { "data-stx-parent-bindings": "text", testID: "period-label" }, style: { fontSize: 14, color: "#cbd5e1" }, events: {}, children: [], _inlineStyle: {}, bindingId: 3, _classes: "text-sm text-slate-300", bindings: { text: "periodName()" } }, { type: "Button", props: { "data-stx-parent-events": "click", type: "button", testID: "cycle-period" }, style: {}, events: { onPress: "cyclePeriod()" }, children: ["Change the period"], _inlineStyle: {}, bindingId: 4 }, { type: "Text", props: { "data-stx-parent-bindings": "text", testID: "metric-label" }, style: { fontSize: 14, color: "#cbd5e1" }, events: {}, children: [], _inlineStyle: {}, bindingId: 5, _classes: "text-sm text-slate-300", bindings: { text: "metricName()" } }, { type: "Button", props: { "data-stx-parent-events": "click", type: "button", testID: "cycle-metric" }, style: {}, events: { onPress: "cycleMetric()" }, children: ["Change the measure"], _inlineStyle: {}, bindingId: 6 }], _inlineStyle: {}, _classes: "mt-4 gap-2" }, { type: "ActivityIndicator", props: { testID: "leaderboard-loading", role: "status" }, style: { marginTop: 24 }, events: {}, children: [], _inlineStyle: {}, _classes: "mt-6", bindings: { if: "loading" }, bindingId: 7 }, { type: "Text", props: { "data-stx-parent-bindings": "text", testID: "leaderboard-error" }, style: { marginTop: 16, color: "#fda4af" }, events: {}, children: [], _inlineStyle: {}, bindingId: 9, _classes: "mt-4 text-rose-300", bindings: { if: "error", text: "error" } }, { type: "Text", props: { testID: "leaderboard-signed-out" }, style: { marginTop: 16, fontSize: 14, color: "#94a3b8" }, events: {}, children: ["Sign in to see how you rank against the people you follow."], _inlineStyle: {}, _classes: "mt-4 text-sm text-slate-400", bindings: { if: "needsSignIn" }, bindingId: 10 }, { type: "View", props: { testID: "leaderboard-list" }, style: { marginTop: 20, gap: 12 }, events: {}, children: [{ type: "Pressable", props: { "data-stx-parent-bindings": "key", "data-stx-parent-events": "click", testID: "leader-row", role: "button" }, style: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 12, backgroundColor: "#0f172a", padding: 12 }, events: { onPress: "openAthlete(row)" }, children: [{ type: "Text", props: { "data-stx-parent-bindings": "text", testID: "leader-rank" }, style: { width: 28, textAlign: "center", fontSize: 16, fontWeight: "bold", color: "#94a3b8" }, events: {}, children: [], _inlineStyle: {}, bindingId: 13, _classes: "w-7 text-center text-base font-bold text-slate-400", bindings: { text: "row.rank" } }, { type: "Image", props: { "data-stx-parent-bindings": "source", testID: "leader-avatar" }, style: { height: 40, width: 40, borderRadius: 9999 }, events: {}, children: [], _inlineStyle: {}, bindingId: 15, _classes: "h-10 w-10 rounded-full", bindings: { if: "photo(row)", source: "photo(row)" } }, { type: "Text", props: { "data-stx-parent-bindings": "text", testID: "leader-initial" }, style: { height: 40, width: 40, borderRadius: 9999, backgroundColor: "#1e293b", textAlign: "center", fontSize: 16, fontWeight: "bold", color: "#cbd5e1" }, events: {}, children: [], _inlineStyle: {}, bindingId: 17, _classes: "h-10 w-10 rounded-full bg-slate-800 text-center text-base font-bold text-slate-300", bindings: { if: "!photo(row)", text: "initial(row)" } }, { type: "View", props: {}, style: { flex: 1, flexGrow: 1, flexShrink: 1, flexBasis: 0 }, events: {}, children: [{ type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 16, fontWeight: "600", color: "#ffffff" }, events: {}, children: [], _inlineStyle: {}, bindingId: 18, _classes: "text-base font-semibold text-white", bindings: { text: "row.userName" } }, { type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 12, color: "#94a3b8" }, events: {}, children: [], _inlineStyle: {}, bindingId: 19, _classes: "text-xs text-slate-400", bindings: { text: "secondary(row)" } }], _inlineStyle: {}, _classes: "flex-1" }, { type: "Text", props: { "data-stx-parent-bindings": "text" }, style: { fontSize: 18, fontWeight: "bold", color: "#6ee7b7" }, events: {}, children: [], _inlineStyle: {}, bindingId: 20, _classes: "text-lg font-bold text-emerald-300", bindings: { text: "figure(row)" } }], _inlineStyle: {}, bindingId: 12, _classes: "flex-row items-center gap-3 rounded-xl bg-slate-900 p-3", bindings: { for: "row in rows()", key: "row.rank" } }], _inlineStyle: {}, _classes: "mt-5 gap-3" }, { type: "Text", props: { testID: "leaderboard-empty" }, style: { marginTop: 24, fontSize: 14, color: "#94a3b8" }, events: {}, children: ["Nobody has logged anything in this period yet."], _inlineStyle: {}, _classes: "mt-6 text-sm text-slate-400", bindings: { if: "!loading && !error && !needsSignIn && rows().length === 0" }, bindingId: 21 }], _inlineStyle: {}, _classes: "p-4" }], _inlineStyle: {}, _classes: "flex-1 bg-slate-950" }, script: { exports: {}, functions: ["period", "metric", "scope", "headline", "periodName", "metricName", "scopeName", "figure", "secondary", "photo", "initial", "readToken", "load", "cyclePeriod", "cycleMetric", "cycleScope", "openAthlete"], code: `import type { NativeCraft } from '@stacksjs/stx/native'
import { avatarInitial, avatarUrl } from '../functions/avatars'
import {
  LEADERBOARD_METRICS,
  LEADERBOARD_PERIODS,
  leaderboardQuery,
  leaderMetricText,
  leaderRowsFrom,
  leaderSecondaryText,
  metricPhrase,
  periodPhrase,
} from '../functions/leaderboard'

/*
 * The leaderboard, natively.
 *
 * Third list screen, and the first with a remote image on every row, so this
 * is where \`Image\` earns its place. The period, the measure, the query they
 * build and the way a row's figures are put into words all come from
 * \`resources/functions/leaderboard.ts\` — the module the web page reads. The two
 * screens choose differently between a row of pills and a cycling button, and
 * must not choose differently about what "this week" covers.
 *
 * Two of the web page's three scopes are here. \`following\` needs the token, so
 * it asks for one and says what signing in would get. \`local\` needs a
 * coordinate, and geolocation is not in the native capability set
 * (fetch, secureStorage, haptics, lifecycle), so it stays on the web side.
 */

const craft = (globalThis as typeof globalThis & { craft: NativeCraft }).craft

const SCOPES = ['global', 'following'] as const

const periodIndex = state(0)
const metricIndex = state(0)
const scopeIndex = state(0)
const rows = state<any[]>([])
const loading = state(true)
const error = state('')
const needsSignIn = state(false)
const bearer = state('')
let active = true

function period(): any {
  return LEADERBOARD_PERIODS[periodIndex()]
}

function metric(): any {
  return LEADERBOARD_METRICS[metricIndex()]
}

function scope(): any {
  return SCOPES[scopeIndex()]
}

/** "Who covered the most ground this week." */
function headline(): string {
  return \`Who \${metricPhrase(metric())} \${periodPhrase(period())}.\`
}

function periodName(): string {
  return periodPhrase(period())
}

function metricName(): string {
  return metricPhrase(metric())
}

function scopeName(): string {
  return scope() === 'following' ? 'People you follow' : 'Everyone'
}

function figure(row: any): string {
  return leaderMetricText(row, metric())
}

function secondary(row: any): string {
  return leaderSecondaryText(row, metric())
}

/*
 * The thumbnail, not the full photo: \`avatarUrl\` answers the \`-thumb\` variant
 * by default, which is the whole point of asking for it on a list row over
 * mobile data. An account with no photo answers '' and gets its initial.
 */
function photo(row: any): string {
  return avatarUrl(row?.userAvatar ?? null)
}

function initial(row: any): string {
  return avatarInitial(row?.userName ?? '')
}

/** Read once and kept: one round trip rather than two, not a bridge limitation. */
async function readToken(): Promise<string> {
  if (bearer())
    return bearer()
  const value = await craft.secureStorage.get('auth_token')
  const token = typeof value === 'string' ? value : ''
  bearer.set(token)
  return token
}

async function load(): Promise<void> {
  loading.set(true)
  error.set('')
  needsSignIn.set(false)
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (scope() === 'following') {
      const token = await readToken()
      if (!token) {
        if (active) {
          needsSignIn.set(true)
          rows.set([])
          loading.set(false)
        }
        return
      }
      headers.Authorization = \`Bearer \${token}\`
    }

    const query = leaderboardQuery({ period: period(), metric: metric(), scope: scope() })
    const response = await fetch(\`https://wildloop.org/api/activities/leaderboard?\${query}\`, { headers })
    const body = await response.json().catch(() => null)
    if (!active)
      return
    if (!response.ok)
      throw new Error('Could not load the leaderboard')
    rows.set(leaderRowsFrom(body))
  }
  catch (cause) {
    if (active)
      error.set(cause instanceof Error ? cause.message : 'Could not load the leaderboard')
  }
  finally {
    if (active)
      loading.set(false)
  }
}

function cyclePeriod(): void {
  periodIndex.set((periodIndex() + 1) % LEADERBOARD_PERIODS.length)
  void load()
}

function cycleMetric(): void {
  metricIndex.set((metricIndex() + 1) % LEADERBOARD_METRICS.length)
  void load()
}

function cycleScope(): void {
  scopeIndex.set((scopeIndex() + 1) % SCOPES.length)
  void load()
}

/*
 * A row with no athlete behind it goes nowhere. The board aggregates anonymous
 * activity under one "Athlete", and that row has no profile to open.
 */
function openAthlete(row: any): void {
  if (!row?.userId)
    return
  craft.navigation.open(\`/athlete/\${row.userId}\`)
}

onMount(() => {
  craft.navigation.setOptions({ title: 'Leaderboard', largeTitle: true })
  void load()
})

onDestroy(() => {
  active = false
})` }, meta: { source: "/Users/glennmichaeltorregosa/Documents/Stacks/wildloop/resources/native/Leaderboard.stx", compiledAt: 1791898294777 } };
    manifest = { entries: [{ id: 0, bindings: [{ name: ":text", value: "headline()", kind: "text" }] }, { id: 1, bindings: [{ name: ":text", value: "scopeName()", kind: "text" }] }, { id: 2, bindings: [{ name: "@click", value: "cycleScope()", kind: "event" }] }, { id: 3, bindings: [{ name: ":text", value: "periodName()", kind: "text" }] }, { id: 4, bindings: [{ name: "@click", value: "cyclePeriod()", kind: "event" }] }, { id: 5, bindings: [{ name: ":text", value: "metricName()", kind: "text" }] }, { id: 6, bindings: [{ name: "@click", value: "cycleMetric()", kind: "event" }] }, { id: 7, bindings: [{ name: ":if", value: "loading", kind: "if" }] }, { id: 8, bindings: [{ name: ":if", value: "error", kind: "if" }] }, { id: 9, bindings: [{ name: ":text", value: "error", kind: "text" }] }, { id: 10, bindings: [{ name: ":if", value: "needsSignIn", kind: "if" }] }, { id: 11, bindings: [{ name: ":for", value: "row in rows()", kind: "for" }], template: true }, { id: 12, bindings: [{ name: ":key", value: "row.rank", kind: "attr" }, { name: "@click", value: "openAthlete(row)", kind: "event" }] }, { id: 13, bindings: [{ name: ":text", value: "row.rank", kind: "text" }] }, { id: 14, bindings: [{ name: ":if", value: "photo(row)", kind: "if" }] }, { id: 15, bindings: [{ name: ":source", value: "photo(row)", kind: "attr" }] }, { id: 16, bindings: [{ name: ":if", value: "!photo(row)", kind: "if" }] }, { id: 17, bindings: [{ name: ":text", value: "initial(row)", kind: "text" }] }, { id: 18, bindings: [{ name: ":text", value: "row.userName", kind: "text" }] }, { id: 19, bindings: [{ name: ":text", value: "secondary(row)", kind: "text" }] }, { id: 20, bindings: [{ name: ":text", value: "figure(row)", kind: "text" }] }, { id: 21, bindings: [{ name: ":if", value: "!loading && !error && !needsSignIn && rows().length === 0", kind: "if" }] }] };
  } else if (routeName === "zzprobe") {
    nativeDocument = { version: "1.0.0", root: { type: "SafeAreaView", props: { "data-stx": "__stx_setup_154s60yhgc" }, style: { flex: 1, flexGrow: 1, flexShrink: 1, flexBasis: 0 }, events: {}, children: [{ type: "Text", props: { testID: "probe-log" }, style: {}, events: {}, children: [], _inlineStyle: {} }, { type: "Button", props: { "data-stx-parent-events": "click", type: "button", testID: "always" }, style: {}, events: { onPress: "always()" }, children: ["Always"], _inlineStyle: {}, bindingId: 0 }, { type: "Button", props: { "data-stx-parent-events": "click", type: "button", testID: "true-at-mount" }, style: {}, events: { onPress: "mounted()" }, children: ["True at mount"], _inlineStyle: {}, bindingId: 2, bindings: { if: "onAtMount()" } }, { type: "Button", props: { "data-stx-parent-events": "click", type: "button", testID: "flipped-later" }, style: {}, events: { onPress: "later()" }, children: ["Flipped later"], _inlineStyle: {}, bindingId: 4, bindings: { if: "flipped()" } }], _inlineStyle: {}, _classes: "flex-1" }, script: { exports: {}, functions: ["always", "mounted", "later"], code: `import type { NativeCraft } from '@stacksjs/stx/native'

const craft = (globalThis as typeof globalThis & { craft: NativeCraft }).craft
const onAtMount = state(true)
const flipped = state(false)
const log = state('none')

function always(): void {
  log.set('always-ran')
}

function mounted(): void {
  log.set('mounted-ran')
}

function later(): void {
  log.set('later-ran')
}

onMount(() => {
  craft.navigation.setOptions({ title: 'Probe' })
  flipped.set(true)
})` }, meta: { source: "/Users/glennmichaeltorregosa/Documents/Stacks/wildloop/resources/native/ZzProbe.stx", compiledAt: 1791898294783 } };
    manifest = { entries: [{ id: 0, bindings: [{ name: "@click", value: "always()", kind: "event" }] }, { id: 1, bindings: [{ name: ":if", value: "onAtMount()", kind: "if" }] }, { id: 2, bindings: [{ name: "@click", value: "mounted()", kind: "event" }] }, { id: 3, bindings: [{ name: ":if", value: "flipped()", kind: "if" }] }, { id: 4, bindings: [{ name: "@click", value: "later()", kind: "event" }] }] };
  }
  var screen = prepareSharedNativeScreen(nativeDocument, manifest, bridge, { routeName, routeNames });
  g.__stx_host = screen.host;
  g.__stxNativeUnmount = function() {
    screen.unmount();
  };
  if (!window.__stx_early_mounts)
    window.__stx_early_mounts = [];
  if (!window.__stx_early_destroys)
    window.__stx_early_destroys = [];
  if (!window.onMount)
    window.onMount = function(fn) {
      window.__stx_early_mounts.push(fn);
    };
  if (!window.onDestroy)
    window.onDestroy = function(fn) {
      window.__stx_early_destroys.push(fn);
    };
  (function() {
    var stxHost = window.__stx_host || { setText: function(node, value) {
      node.textContent = value;
    }, setAttribute: function(node, name, value) {
      if (value === false) {
        node.removeAttribute(name);
        return;
      }
      if (value === true) {
        node.setAttribute(name, "");
        return;
      }
      var next = value;
      if (typeof value === "object" && value !== null) {
        try {
          next = JSON.stringify(value);
        } catch (e) {
          next = String(value);
        }
      }
      node.setAttribute(name, next);
    }, removeAttribute: function(node, name) {
      node.removeAttribute(name);
    }, setStyle: function(node, value) {
      if (typeof value === "object" && value !== null) {
        Object.assign(node.style, value);
        if (Object.prototype.hasOwnProperty.call(value, "display"))
          node.__stx_display = value.display || "";
      } else if (typeof value === "string") {
        node.style.cssText = value;
        node.__stx_display = node.style.display || "";
      }
      if (node.__stx_visible === false)
        node.style.display = "none";
    }, listen: function(node, event, handler, options) {
      node.addEventListener(event, handler, options);
    }, scopeOf: function(node, from) {
      var start = from ? node && node.parentElement : node;
      return start && start.closest ? start.closest("[data-stx-scope]") : null;
    }, setVisible: function(node, visible) {
      if (node.__stx_display === undefined) {
        var d = node.style.display;
        node.__stx_display = d && d !== "none" ? d : "";
      }
      var was = node.style.display !== "none";
      node.__stx_visible = visible;
      node.style.display = visible ? node.__stx_display : "none";
      return was;
    }, anchor: function(label) {
      return document.createComment(label);
    }, clone: function(node) {
      return node.cloneNode(true);
    }, insert: function(parent, node, before) {
      parent.insertBefore(node, before);
    }, remove: function(node) {
      if (node.parentNode)
        node.parentNode.removeChild(node);
    }, descendants: function(node) {
      var out = [];
      if (!node || !node.querySelectorAll)
        return out;
      var all = node.querySelectorAll("*");
      for (var i = 0;i < all.length; i++)
        out.push(all[i]);
      return out;
    }, scopesIn: function(node) {
      var ids = [];
      if (!node)
        return ids;
      var own = node.getAttribute && node.getAttribute("data-stx-scope");
      if (own)
        ids.push(own);
      if (node.querySelectorAll) {
        var matches = node.querySelectorAll("[data-stx-scope]");
        for (var i = 0;i < matches.length; i++) {
          var id = matches[i].getAttribute("data-stx-scope");
          if (id)
            ids.push(id);
        }
      }
      return ids;
    } };
    var cloakStyle = document.getElementById ? document.getElementById("stx-cloak-style") : null;
    if (!cloakStyle) {
      cloakStyle = document.createElement("style");
      cloakStyle.id = "stx-cloak-style";
      cloakStyle.textContent = "[x-cloak] { display: none !important; }";
      document.head.appendChild(cloakStyle);
    }
    const __stxCompiled = new Map;
    function __stxCompile(params, body) {
      const key = params.join(",") + "\x01" + body;
      let fn = __stxCompiled.get(key);
      if (!fn) {
        fn = new Function(...params, body);
        if (__stxCompiled.size >= 5000)
          __stxCompiled.clear();
        __stxCompiled.set(key, fn);
      }
      return fn;
    }
    const __stxIdentifiers = new Map;
    function __stxNamesIn(body) {
      let names = __stxIdentifiers.get(body);
      if (!names) {
        names = Array.from(new Set(body.match(/[A-Za-z_$][\w$]*/g) || []));
        if (__stxIdentifiers.size >= 5000)
          __stxIdentifiers.clear();
        __stxIdentifiers.set(body, names);
      }
      return names;
    }
    function __stxCompileScoped(scope, extraParams, body) {
      const keys = [];
      const names = __stxNamesIn(body);
      for (let i = 0;i < names.length; i++) {
        if (Object.prototype.propertyIsEnumerable.call(scope, names[i]))
          keys.push(names[i]);
      }
      const fn = __stxCompile(extraParams.length ? keys.concat(extraParams) : keys, body);
      fn.__stxKeys = keys;
      return fn;
    }
    function __stxArgs(fn, scope) {
      const keys = fn.__stxKeys;
      const args = new Array(keys.length);
      for (let i = 0;i < keys.length; i++)
        args[i] = scope[keys[i]];
      return args;
    }
    let activeEffect = null;
    const effectStack = [];
    const pendingEffects = new Set;
    let isBatching = false;
    var __stxDevtoolsTracking = false;
    var __stxDevtoolsStats = { signalSets: 0, effectRuns: 0 };
    var __stxEffectId = 0;
    var __stxDevtoolsIfTrace = [];
    var __stxDevtoolsQueries = [];
    var __stxDevtoolsMutations = [];
    var __stxSignalId = 0;
    function __stxDevtoolsNow() {
      return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    }
    function __stxDevtoolsRecordIf(rec) {
      if (!__stxDevtoolsTracking)
        return;
      __stxDevtoolsIfTrace.push(rec);
      if (__stxDevtoolsIfTrace.length > 100)
        __stxDevtoolsIfTrace.shift();
    }
    function __stxDevtoolsRecordQuery(rec) {
      if (!__stxDevtoolsTracking)
        return;
      __stxDevtoolsQueries.push(rec);
      if (__stxDevtoolsQueries.length > 100)
        __stxDevtoolsQueries.shift();
    }
    function __stxShort(v) {
      try {
        if (typeof v === "string")
          return v.length > 40 ? v.slice(0, 40) + "…" : v;
        if (v === null || typeof v !== "object")
          return v;
        var s = JSON.stringify(v);
        return s.length > 60 ? s.slice(0, 60) + "…" : s;
      } catch (e) {
        return "[unserializable]";
      }
    }
    function __stxRawBody(body) {
      return typeof FormData !== "undefined" && body instanceof FormData || typeof Blob !== "undefined" && body instanceof Blob || typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams || typeof ArrayBuffer !== "undefined" && (body instanceof ArrayBuffer || ArrayBuffer.isView(body));
    }
    async function __stxHttpError(response) {
      var body = null;
      var text = "";
      try {
        text = await response.text();
      } catch (e) {
        text = "";
      }
      if (text) {
        try {
          body = JSON.parse(text);
        } catch (e) {
          body = text;
        }
      }
      var detail = "";
      if (body && typeof body === "object")
        detail = body.message || body.error || "";
      else if (typeof body === "string")
        detail = body.slice(0, 200);
      var message = "HTTP " + response.status;
      if (response.statusText)
        message += ": " + response.statusText;
      if (detail)
        message += " - " + detail;
      var err = new Error(message);
      err.status = response.status;
      err.statusText = response.statusText;
      err.data = body;
      err.response = response;
      return err;
    }
    var __stxFetchHooks = { onRequest: null, onResponse: null, onResponseError: null };
    var __stxCsrf = { cookie: "X-CSRF-Token", header: "X-CSRF-Token" };
    function __stxCookie(name) {
      if (typeof document === "undefined" || !document.cookie)
        return null;
      var parts = document.cookie.split(";");
      for (var i = 0;i < parts.length; i++) {
        var at = parts[i].indexOf("=");
        if (at === -1)
          continue;
        if (parts[i].slice(0, at).trim() !== name)
          continue;
        var value = parts[i].slice(at + 1).trim();
        try {
          return value ? decodeURIComponent(value) : null;
        } catch (e) {
          return value || null;
        }
      }
      return null;
    }
    function __stxWantsCsrf(url, opts) {
      if (!__stxCsrf)
        return false;
      var method = String(opts && opts.method || "GET").toUpperCase();
      if (method === "GET" || method === "HEAD" || method === "OPTIONS")
        return false;
      var target = String(url);
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.slice(0, 2) === "//") {
        if (typeof location === "undefined")
          return false;
        try {
          if (new URL(target).origin !== location.origin)
            return false;
        } catch (e) {
          return false;
        }
      }
      return true;
    }
    var __stxCsrfPriming = null;
    async function __stxPrimeCsrf(url, opts) {
      if (!__stxCsrf || !__stxCsrf.prime || !__stxWantsCsrf(url, opts))
        return;
      if (__stxCookie(__stxCsrf.cookie))
        return;
      if (!__stxCsrfPriming) {
        __stxCsrfPriming = fetch(__stxCsrf.prime, { credentials: "same-origin", headers: { Accept: "application/json" } }).then(function() {}, function() {}).then(function() {
          __stxCsrfPriming = null;
        });
      }
      await __stxCsrfPriming;
    }
    function __stxApplyCsrf(url, opts) {
      if (!__stxWantsCsrf(url, opts))
        return;
      var token = __stxCookie(__stxCsrf.cookie);
      if (!token)
        return;
      var headers = __stxHeaders(opts.headers);
      var wanted = __stxCsrf.header.toLowerCase();
      for (var key in headers) {
        if (key.toLowerCase() === wanted)
          return;
      }
      headers[__stxCsrf.header] = token;
      opts.headers = headers;
    }
    function configureFetch(cfg) {
      cfg = cfg || {};
      if (Object.prototype.hasOwnProperty.call(cfg, "csrf")) {
        __stxCsrf = cfg.csrf === false || cfg.csrf === null ? null : { cookie: cfg.csrf && cfg.csrf.cookie || "X-CSRF-Token", header: cfg.csrf && (cfg.csrf.header || cfg.csrf.cookie) || "X-CSRF-Token", prime: cfg.csrf && typeof cfg.csrf.prime === "string" && cfg.csrf.prime || null };
      }
      __stxFetchHooks.onRequest = typeof cfg.onRequest === "function" ? cfg.onRequest : null;
      __stxFetchHooks.onResponse = typeof cfg.onResponse === "function" ? cfg.onResponse : null;
      __stxFetchHooks.onResponseError = typeof cfg.onResponseError === "function" ? cfg.onResponseError : null;
    }
    function __stxHeaders(h) {
      return (typeof h === "function" ? h() : h) || {};
    }
    async function __stxFetch(source, url, opts) {
      var t0 = __stxDevtoolsNow();
      opts = opts || {};
      await __stxPrimeCsrf(url, opts);
      __stxApplyCsrf(url, opts);
      if (__stxFetchHooks.onRequest) {
        opts.headers = __stxHeaders(opts.headers);
        var reqCtx = { source, url: String(url), options: opts };
        await __stxFetchHooks.onRequest(reqCtx);
        if (reqCtx.url)
          url = reqCtx.url;
        opts = reqCtx.options || opts;
      }
      var method = opts && opts.method || "GET";
      function __stxIsResponse(v) {
        return !!v && typeof v.ok === "boolean";
      }
      try {
        var r = await fetch(url, opts);
        __stxDevtoolsRecordQuery({ source, url: String(url), method, status: r.status, ok: r.ok, ms: __stxDevtoolsNow() - t0 });
        if (__stxFetchHooks.onResponse) {
          await __stxFetchHooks.onResponse({ source, url: String(url), options: opts, response: r });
        }
        if (!r.ok && __stxFetchHooks.onResponseError) {
          var recovered = await __stxFetchHooks.onResponseError({ source, url: String(url), options: opts, response: r, error: null });
          if (__stxIsResponse(recovered)) {
            __stxDevtoolsRecordQuery({ source, url: String(url), method, status: recovered.status, ok: recovered.ok, retried: true, ms: __stxDevtoolsNow() - t0 });
            return recovered;
          }
        }
        return r;
      } catch (e) {
        __stxDevtoolsRecordQuery({ source, url: String(url), method, status: 0, ok: false, error: String(e && e.message || e), ms: __stxDevtoolsNow() - t0 });
        if (__stxFetchHooks.onResponseError) {
          var recoveredErr = await __stxFetchHooks.onResponseError({ source, url: String(url), options: opts, response: null, error: e });
          if (__stxIsResponse(recoveredErr)) {
            __stxDevtoolsRecordQuery({ source, url: String(url), method, status: recoveredErr.status, ok: recoveredErr.ok, retried: true, ms: __stxDevtoolsNow() - t0 });
            return recoveredErr;
          }
        }
        throw e;
      }
    }
    let activeDisposers = null;
    const targetMap = new WeakMap;
    const globalHelpers = { fmt(n) {
      if (n == null)
        return "0";
      n = Number(n);
      if (n >= 1e6)
        return (n / 1e6).toFixed(1) + "M";
      if (n >= 1000)
        return (n / 1000).toFixed(1) + "K";
      return String(n);
    }, formatDate(date, format = "YYYY-MM-DD") {
      if (!date)
        return "";
      const d = date instanceof Date ? date : new Date(date);
      if (isNaN(d.getTime()))
        return "";
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const hours = String(d.getHours()).padStart(2, "0");
      const minutes = String(d.getMinutes()).padStart(2, "0");
      const seconds = String(d.getSeconds()).padStart(2, "0");
      return format.replace("YYYY", year).replace("MM", month).replace("DD", day).replace("HH", hours).replace("mm", minutes).replace("ss", seconds);
    }, timeAgo(date) {
      if (!date)
        return "";
      const d = date instanceof Date ? date : new Date(date);
      const now = new Date;
      const seconds = Math.floor((now - d) / 1000);
      if (seconds < 60)
        return "just now";
      if (seconds < 3600)
        return Math.floor(seconds / 60) + "m ago";
      if (seconds < 86400)
        return Math.floor(seconds / 3600) + "h ago";
      if (seconds < 604800)
        return Math.floor(seconds / 86400) + "d ago";
      return d.toLocaleDateString();
    }, debounce(fn, delay = 300) {
      let timeout;
      return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), delay);
      };
    }, throttle(fn, limit = 300) {
      let inThrottle;
      return function(...args) {
        if (!inThrottle) {
          fn.apply(this, args);
          inThrottle = true;
          setTimeout(() => inThrottle = false, limit);
        }
      };
    }, capitalize(str) {
      if (!str)
        return "";
      return str.charAt(0).toUpperCase() + str.slice(1);
    }, truncate(str, length = 50, suffix = "...") {
      if (!str || str.length <= length)
        return str || "";
      return str.slice(0, length) + suffix;
    }, json(value, indent = 2) {
      try {
        return JSON.stringify(value, null, indent);
      } catch (e) {
        return String(value);
      }
    }, pluralize(count, singular, plural) {
      const p = plural || singular + "s";
      return count === 1 ? singular : p;
    }, clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }, currency(value, symbol = "$", decimals = 2) {
      if (value == null)
        return symbol + "0.00";
      return symbol + Number(value).toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }, percent(value, decimals = 0) {
      if (value == null)
        return "0%";
      return (Number(value) * 100).toFixed(decimals) + "%";
    } };
    function track(target, key) {
      if (!activeEffect)
        return;
      let depsMap = targetMap.get(target);
      if (!depsMap)
        targetMap.set(target, depsMap = new Map);
      let deps = depsMap.get(key);
      if (!deps)
        depsMap.set(key, deps = new Set);
      deps.add(activeEffect);
    }
    function trigger(target, key) {
      const depsMap = targetMap.get(target);
      if (!depsMap)
        return;
      const deps = depsMap.get(key);
      if (deps) {
        if (isBatching) {
          deps.forEach((effect) => pendingEffects.add(effect));
        } else {
          deps.forEach((effect) => effect());
        }
      }
    }
    function createAutoUnwrapProxy(scope, preserveSignal) {
      return new Proxy(scope, { get(target, prop) {
        const val = target[prop];
        if (val && typeof val === "function" && (val._isSignal || val._isDerived)) {
          if (val._isStxLoopItem)
            return val();
          if (preserveSignal && preserveSignal(prop, val))
            return val;
          return val();
        }
        if (val && typeof val === "object" && val._isStxStore) {
          return createAutoUnwrapProxy(val, preserveSignal);
        }
        return val;
      }, set(target, prop, value) {
        const cur = target[prop];
        if (cur && typeof cur === "function" && cur._isSignal && typeof cur.set === "function") {
          cur.set(value);
          return true;
        }
        target[prop] = value;
        return true;
      } });
    }
    function createModelWriteProxy(target) {
      return new Proxy(target, { get(t, prop) {
        var val = t[prop];
        if (val && typeof val === "function" && (val._isSignal || val._isDerived)) {
          var inner = val();
          return inner && typeof inner === "object" ? createModelWriteProxy(inner) : inner;
        }
        if (val && typeof val === "object")
          return createModelWriteProxy(val);
        return val;
      }, set(t, prop, value) {
        var cur = t[prop];
        if (cur && typeof cur === "function" && cur._isSignal && typeof cur.set === "function") {
          cur.set(value);
          return true;
        }
        t[prop] = value;
        return true;
      } });
    }
    function parsePipeExpression(expr, scope) {
      let pipeIndex = -1;
      let inString = false;
      let stringChar = "";
      let depth = 0;
      for (let i = 0;i < expr.length; i++) {
        const char = expr[i];
        const prevChar = i > 0 ? expr[i - 1] : "";
        const nextChar = i < expr.length - 1 ? expr[i + 1] : "";
        if ((char === '"' || char === "'" || char === "`") && prevChar !== "\\") {
          if (!inString) {
            inString = true;
            stringChar = char;
          } else if (char === stringChar) {
            inString = false;
          }
          continue;
        }
        if (inString)
          continue;
        if (char === "(" || char === "[" || char === "{")
          depth++;
        if (char === ")" || char === "]" || char === "}")
          depth--;
        if (depth !== 0)
          continue;
        if (char === "|") {
          if (nextChar === "|") {
            i++;
            continue;
          }
          if (prevChar === "|")
            continue;
          if (prevChar === "?")
            continue;
          pipeIndex = i;
          break;
        }
      }
      if (pipeIndex === -1)
        return null;
      const valueExpr = expr.slice(0, pipeIndex).trim();
      const pipeChain = expr.slice(pipeIndex + 1).trim();
      const pipes = [];
      let currentPipe = "";
      inString = false;
      stringChar = "";
      depth = 0;
      for (let i = 0;i < pipeChain.length; i++) {
        const char = pipeChain[i];
        const prevChar = i > 0 ? pipeChain[i - 1] : "";
        const nextChar = i < pipeChain.length - 1 ? pipeChain[i + 1] : "";
        if ((char === '"' || char === "'" || char === "`") && prevChar !== "\\") {
          if (!inString) {
            inString = true;
            stringChar = char;
          } else if (char === stringChar) {
            inString = false;
          }
          currentPipe += char;
          continue;
        }
        if (inString) {
          currentPipe += char;
          continue;
        }
        if (char === "(" || char === "[" || char === "{")
          depth++;
        if (char === ")" || char === "]" || char === "}")
          depth--;
        if (depth === 0 && char === "|" && nextChar !== "|" && prevChar !== "|" && prevChar !== "?") {
          if (currentPipe.trim()) {
            const parts = currentPipe.trim().split(":");
            pipes.push({ name: parts[0].trim(), args: parts.slice(1).map((a) => a.trim()) });
          }
          currentPipe = "";
        } else {
          currentPipe += char;
        }
      }
      if (currentPipe.trim()) {
        const parts = currentPipe.trim().split(":");
        pipes.push({ name: parts[0].trim(), args: parts.slice(1).map((a) => a.trim()) });
      }
      if (pipes.length === 0)
        return null;
      return { valueExpr, pipes };
    }
    function executePipeExpression(valueExpr, pipes, scope) {
      let value;
      try {
        const fn = __stxCompileScoped(scope, [], "return " + valueExpr);
        value = fn(...__stxArgs(fn, scope));
      } catch (e) {
        if (!(e instanceof ReferenceError) && !(e instanceof TypeError))
          console.warn("[STX] Pipe base expression error:", valueExpr, e);
        return "";
      }
      for (const pipe of pipes) {
        const filterFn = scope[pipe.name] || globalHelpers[pipe.name];
        if (typeof filterFn === "function") {
          try {
            const parsedArgs = pipe.args.map((arg) => {
              if (/^-?\d+(\.\d+)?$/.test(arg))
                return Number(arg);
              if (/^['"].*['"]$/.test(arg))
                return arg.slice(1, -1);
              try {
                const fn = __stxCompileScoped(scope, [], "return " + arg);
                return fn(...__stxArgs(fn, scope));
              } catch (e) {
                return arg;
              }
            });
            value = filterFn(value, ...parsedArgs);
          } catch (e) {
            if (!(e instanceof ReferenceError) && !(e instanceof TypeError))
              console.warn("[STX] Pipe filter error:", pipe.name, e);
          }
        } else {
          console.warn("[STX] Unknown pipe/filter:", pipe.name);
        }
      }
      return value;
    }
    function state(initialValue) {
      let value = initialValue;
      const subscribers = new Set;
      const effects = new Set;
      const signal = () => {
        if (activeEffect) {
          effects.add(activeEffect);
        }
        return value;
      };
      signal.set = (newValue) => {
        if (!Object.is(newValue, value)) {
          if (__stxDevtoolsTracking) {
            signal._setCount++;
            __stxDevtoolsStats.signalSets++;
            __stxDevtoolsMutations.push({ sid: signal._stxSignalId, prev: __stxShort(value), next: __stxShort(newValue) });
            if (__stxDevtoolsMutations.length > 100)
              __stxDevtoolsMutations.shift();
          }
          const prev = value;
          value = newValue;
          subscribers.forEach((cb) => {
            try {
              cb(value, prev);
            } catch (e) {
              console.error("[stx] subscriber error:", e);
            }
          });
          if (isBatching) {
            effects.forEach((effect) => pendingEffects.add(effect));
          } else {
            effects.forEach((effect) => effect());
          }
        }
      };
      signal.update = (fn) => signal.set(fn(value));
      signal.trigger = () => {
        subscribers.forEach((cb) => {
          try {
            cb(value, value);
          } catch (e) {
            console.error("[stx] subscriber error:", e);
          }
        });
        if (isBatching) {
          effects.forEach((effect) => pendingEffects.add(effect));
        } else {
          effects.forEach((effect) => effect());
        }
      };
      signal.subscribe = (cb) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      };
      signal._isSignal = true;
      signal._effects = effects;
      signal._setCount = 0;
      signal._stxSignalId = ++__stxSignalId;
      Object.defineProperty(signal, "value", { get() {
        return signal();
      }, set(v) {
        signal.set(v);
      }, configurable: true });
      return signal;
    }
    function derived(compute) {
      let cached;
      let isDirty = true;
      const effects = new Set;
      const markDirty = () => {
        if (!isDirty) {
          isDirty = true;
          if (isBatching) {
            effects.forEach((e) => pendingEffects.add(e));
          } else {
            effects.forEach((e) => e());
          }
        }
      };
      const signal = () => {
        if (activeEffect)
          effects.add(activeEffect);
        if (isDirty) {
          const prev = activeEffect;
          activeEffect = markDirty;
          effectStack.push(markDirty);
          try {
            cached = compute();
          } finally {
            effectStack.pop();
            activeEffect = prev;
          }
          isDirty = false;
        }
        return cached;
      };
      signal._isDerived = true;
      signal._effects = effects;
      Object.defineProperty(signal, "value", { get() {
        return signal();
      }, configurable: true });
      return signal;
    }
    function effect(fn, options = {}) {
      let cleanup;
      let isDisposed = false;
      const runEffect = () => {
        if (isDisposed)
          return;
        if (__stxDevtoolsTracking) {
          runEffect._runCount++;
          __stxDevtoolsStats.effectRuns++;
        }
        if (cleanup) {
          const pending = cleanup;
          cleanup = undefined;
          try {
            pending();
          } catch (e) {
            console.error("[stx] effect cleanup error:", e);
          }
        }
        const prev = activeEffect;
        activeEffect = runEffect;
        effectStack.push(runEffect);
        try {
          var __result = fn();
          cleanup = typeof __result === "function" ? __result : undefined;
        } catch (e) {
          isDisposed = true;
          if (e instanceof ReferenceError) {} else {
            console.error("[stx] effect error (the effect is disposed):", e);
          }
        } finally {
          effectStack.pop();
          activeEffect = prev;
        }
      };
      runEffect._isStxEffect = true;
      runEffect._stxId = ++__stxEffectId;
      runEffect._runCount = 0;
      if (options.immediate !== false)
        runEffect();
      const dispose = () => {
        isDisposed = true;
        if (cleanup) {
          const pending = cleanup;
          cleanup = undefined;
          pending();
        }
      };
      if (activeDisposers)
        activeDisposers.push(dispose);
      return dispose;
    }
    function trackEffects(fn) {
      var parentDisposers = activeDisposers;
      var disposers = [];
      activeDisposers = disposers;
      try {
        fn();
      } finally {
        activeDisposers = parentDisposers;
        if (parentDisposers) {
          disposers.forEach(function(d) {
            parentDisposers.push(d);
          });
        }
      }
      return function disposeAll() {
        disposers.forEach(function(d) {
          try {
            d();
          } catch (e) {
            console.warn("[stx] dispose error:", e);
          }
        });
        disposers.length = 0;
      };
    }
    function batch(fn) {
      if (isBatching) {
        fn();
        return;
      }
      isBatching = true;
      try {
        fn();
      } finally {
        isBatching = false;
        const queued = Array.from(pendingEffects);
        pendingEffects.clear();
        queued.forEach((e) => e());
      }
    }
    function isSignal(v) {
      return typeof v === "function" && v._isSignal === true;
    }
    function isDerived(v) {
      return typeof v === "function" && v._isDerived === true;
    }
    function untrack(v) {
      return isSignal(v) || typeof v === "function" && v._isDerived ? v() : v;
    }
    function peek(fn) {
      const prev = activeEffect;
      activeEffect = null;
      try {
        return fn();
      } finally {
        activeEffect = prev;
      }
    }
    const mountCallbacks = [];
    const destroyCallbacks = [];
    function currentLifecycleScope() {
      var el = window.__STX_CURRENT_ELEMENT__;
      if (!el || !el.getAttribute || !window.stx || !window.stx._scopes)
        return null;
      var scopeId = el.getAttribute("data-stx-scope");
      return scopeId ? window.stx._scopes[scopeId] || null : null;
    }
    function onMount(fn) {
      var scope = currentLifecycleScope();
      if (scope) {
        scope.__mountCallbacks = scope.__mountCallbacks || [];
        scope.__mountCallbacks.push(fn);
        return;
      }
      mountCallbacks.push(fn);
    }
    var activeDestroySink = null;
    function onDestroy(fn) {
      var scope = currentLifecycleScope();
      if (scope) {
        scope.__destroyCallbacks = scope.__destroyCallbacks || [];
        scope.__destroyCallbacks.push(fn);
        return;
      }
      if (activeDestroySink) {
        activeDestroySink.push(fn);
        return;
      }
      destroyCallbacks.push(fn);
    }
    function runMountCallbacks(list, sink) {
      if (!list || !list.length)
        return;
      var target = sink || destroyCallbacks;
      var batch = list.splice(0, list.length);
      var previousSink = activeDestroySink;
      activeDestroySink = target;
      try {
        for (var i = 0;i < batch.length; i++) {
          try {
            var cleanup = batch[i]();
            if (typeof cleanup === "function")
              target.push(cleanup);
          } catch (e) {
            console.error("[stx] onMount error:", e);
          }
        }
      } finally {
        activeDestroySink = previousSink;
      }
    }
    function scopeDestroySink(scopeVars) {
      if (!scopeVars)
        return destroyCallbacks;
      scopeVars.__destroyCallbacks = scopeVars.__destroyCallbacks || [];
      return scopeVars.__destroyCallbacks;
    }
    if (window.__stx_early_mounts) {
      window.__stx_early_mounts.forEach(function(fn) {
        mountCallbacks.push(fn);
      });
      window.__stx_early_mounts = null;
    }
    if (window.__stx_early_destroys) {
      window.__stx_early_destroys.forEach(function(fn) {
        destroyCallbacks.push(fn);
      });
      window.__stx_early_destroys = null;
    }
    function useWebSocket(url, options) {
      options = options || {};
      var ws = state(null);
      var status = state("CLOSED");
      var lastMessage = state(null);
      var error = state(null);
      var reconnectAttempts = 0;
      var maxReconnects = options.reconnect === false ? 0 : options.maxReconnects || 10;
      var reconnectDelay = options.reconnectDelay || 1000;
      var reconnectTimer = null;
      var manualClose = false;
      var listeners = {};
      var subscriptions = {};
      function connect() {
        if (ws() && ws().readyState <= 1)
          return;
        manualClose = false;
        status.set("CONNECTING");
        error.set(null);
        var socket = new WebSocket(url);
        socket.onopen = function() {
          status.set("OPEN");
          reconnectAttempts = 0;
          for (var channel in subscriptions) {
            send({ event: "subscribe", channel });
          }
          if (options.onOpen)
            options.onOpen(socket);
        };
        socket.onmessage = function(event) {
          var data = event.data;
          try {
            data = JSON.parse(data);
          } catch (e) {}
          lastMessage.set(data);
          if (options.onMessage)
            options.onMessage(data, event);
          if (data && data.channel && data.event) {
            var key = data.channel + ":" + data.event;
            var fns = listeners[key];
            if (fns) {
              for (var i = 0;i < fns.length; i++) {
                fns[i](data.data);
              }
            }
          }
        };
        socket.onerror = function(event) {
          error.set(event);
          if (options.onError)
            options.onError(event);
        };
        socket.onclose = function(event) {
          status.set("CLOSED");
          ws.set(null);
          if (options.onClose)
            options.onClose(event);
          if (!manualClose && reconnectAttempts < maxReconnects) {
            reconnectAttempts++;
            var delay = reconnectDelay * Math.min(reconnectAttempts, 5);
            reconnectTimer = setTimeout(connect, delay);
          }
        };
        ws.set(socket);
      }
      function send(data) {
        var socket = ws();
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(typeof data === "string" ? data : JSON.stringify(data));
        }
      }
      function close() {
        manualClose = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        var socket = ws();
        if (socket)
          socket.close();
      }
      function subscribe(channel) {
        subscriptions[channel] = true;
        var socket = ws();
        if (socket && socket.readyState === WebSocket.OPEN) {
          send({ event: "subscribe", channel });
        }
        return { listen: function(event, handler) {
          var key = channel + ":" + event;
          if (!listeners[key])
            listeners[key] = [];
          listeners[key].push(handler);
          return this;
        }, leave: function() {
          delete subscriptions[channel];
          send({ event: "unsubscribe", channel });
          var prefix = channel + ":";
          for (var key in listeners) {
            if (key.indexOf(prefix) === 0) {
              delete listeners[key];
            }
          }
        } };
      }
      if (options.immediate !== false) {
        connect();
      }
      onDestroy(function() {
        close();
        listeners = {};
      });
      return { ws, status, lastMessage, error, send, close, connect, subscribe };
    }
    var readHydratedData = function readHydratedData(key, hydrate = true, transform) {
      if (!hydrate || !key || typeof window > "u")
        return;
      const host = window;
      if (!host.__STX_DATA__) {
        const tag = document.querySelector("script[data-stx-server-data]");
        try {
          const parsed = JSON.parse(tag?.textContent || "{}");
          host.__STX_DATA__ = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        } catch {
          host.__STX_DATA__ = {};
        }
      }
      const values = host.__STX_DATA__;
      if (values && Object.prototype.hasOwnProperty.call(values, key))
        try {
          return { data: transform ? transform(values[key]) : values[key] };
        } catch (error) {
          return { data: null, error: error instanceof Error ? error : Error(String(error)) };
        }
      return;
    };
    var clearServerData = function clearServerData(key) {
      if (typeof window > "u")
        return;
      const host = window;
      if (key === undefined)
        host.__STX_DATA__ = {};
      else {
        if (!host.__STX_DATA__)
          try {
            const parsed = JSON.parse(document.querySelector("script[data-stx-server-data]")?.textContent || "{}");
            host.__STX_DATA__ = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
          } catch {
            host.__STX_DATA__ = {};
          }
        if (host.__STX_DATA__)
          delete host.__STX_DATA__[key];
      }
    };
    function useFetch(urlOrFn, options = {}) {
      const hydrated = readHydratedData(options.key, options.hydrate !== false, options.transform);
      const initial = hydrated ? hydrated.data : options.initialData ?? null;
      const data = state(initial);
      const immediate = options.immediate !== false && !hydrated;
      const loading = state(immediate);
      const isFetching = state(immediate);
      const error = state(hydrated ? hydrated.error || null : null);
      if (options.suspense)
        registerSuspense(loading, error);
      let __stxAbort = null;
      const fetchData = async (runOptions) => {
        const background = !!(runOptions && runOptions.background);
        if (__stxAbort)
          __stxAbort.abort();
        __stxAbort = typeof AbortController !== "undefined" ? new AbortController : null;
        const __signal = __stxAbort ? __stxAbort.signal : undefined;
        if (!background)
          loading.set(true);
        isFetching.set(true);
        if (!background)
          error.set(null);
        try {
          const url = typeof urlOrFn === "function" ? urlOrFn() : urlOrFn;
          if (!url) {
            if (!background)
              loading.set(false);
            isFetching.set(false);
            return;
          }
          const fetchOptions = { method: options.method || "GET", headers: { "Content-Type": "application/json", ...__stxHeaders(options.headers) }, signal: __signal };
          if (options.body) {
            fetchOptions.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
          }
          const response = await __stxFetch("useFetch", url, fetchOptions);
          if (__signal && __signal.aborted)
            return;
          if (!response.ok)
            throw await __stxHttpError(response);
          const result = await response.json();
          if (__signal && __signal.aborted)
            return;
          const transformed = options.transform ? options.transform(result) : result;
          data.set(transformed);
          if (background)
            error.set(null);
        } catch (e) {
          if (e && e.name === "AbortError")
            return;
          console.error("[STX] useFetch error:", e);
          error.set(e instanceof Error ? e : new Error(String(e)));
          if (options.onError)
            options.onError(e);
        } finally {
          if (!__signal || !__signal.aborted) {
            if (!background)
              loading.set(false);
            isFetching.set(false);
          }
        }
      };
      if (typeof urlOrFn === "function") {
        var firstUrlRun = true;
        effect(() => {
          const url = urlOrFn();
          if (!url)
            return;
          if (firstUrlRun) {
            firstUrlRun = false;
            if (!immediate)
              return;
          }
          fetchData();
        });
      } else if (immediate) {
        onMount(fetchData);
      }
      if (typeof onDestroy === "function")
        onDestroy(function() {
          if (__stxAbort)
            __stxAbort.abort();
        });
      return { data, loading, isFetching, error, refetch: fetchData, get isLoading() {
        return loading();
      }, get hasError() {
        return !!error();
      }, get isEmpty() {
        return !loading() && !data();
      } };
    }
    function useRef(name) {
      var ownerScope = currentLifecycleScope() || componentScope;
      var ownerRefs = ownerScope.$refs || (ownerScope.$refs = {});
      var read = function() {
        return ownerRefs[name] || null;
      };
      Object.defineProperty(read, "current", { get: read, enumerable: true });
      Object.defineProperty(read, "value", { get: read, enumerable: true });
      return read;
    }
    function navigate(url, options) {
      var opts = options && typeof options === "object" ? options : { reload: !!options };
      var replace = !!opts.replace;
      var reload = !!(opts.reload || opts.forceReload);
      if (!reload && window.stxRouter && typeof window.stxRouter.navigate === "function") {
        var routed = { replace };
        if (opts.instant)
          routed.instant = true;
        window.stxRouter.navigate(url, routed);
        return;
      }
      if (replace)
        window.location.replace(url);
      else
        window.location.href = url;
    }
    function refresh() {
      if (window.stxRouter && typeof window.stxRouter.refresh === "function")
        return window.stxRouter.refresh();
      window.location.reload();
      return Promise.resolve(false);
    }
    function invalidateRoute(url) {
      if (window.stxRouter && typeof window.stxRouter.invalidate === "function")
        window.stxRouter.invalidate(url);
    }
    function goBack() {
      window.history.back();
    }
    function goForward() {
      window.history.forward();
    }
    var _routeParams = state({});
    function setRouteParams(params) {
      var nextParams = params || {};
      _routeParams.set(nextParams);
      window.__stx_rp = nextParams;
      if (window.stx)
        window.stx._rp = nextParams;
    }
    window.addEventListener("stx:navigate", function(e) {
      var nextParams = e.detail && Object.prototype.hasOwnProperty.call(e.detail, "params") ? e.detail.params : {};
      setRouteParams(nextParams);
    });
    if (window.stx && window.stx._rp || window.__stx_rp) {
      _routeParams.set(window.stx?._rp || window.__stx_rp);
    }
    function useRoute() {
      return { get path() {
        return window.location.pathname;
      }, get fullPath() {
        return window.location.pathname + window.location.search + window.location.hash;
      }, get hash() {
        return window.location.hash;
      }, get query() {
        var params = {};
        new URLSearchParams(window.location.search).forEach(function(v, k) {
          params[k] = v;
        });
        return params;
      }, get params() {
        return _routeParams();
      } };
    }
    function useRouteParams() {
      return _routeParams();
    }
    function useRouteParam(name, fallback) {
      var value = _routeParams()[name];
      return value === undefined ? fallback : value;
    }
    function useSearchParams() {
      var params = state(Object.fromEntries(new URLSearchParams(window.location.search)));
      var syncFromUrl = function() {
        params.set(Object.fromEntries(new URLSearchParams(window.location.search)));
      };
      window.addEventListener("popstate", syncFromUrl);
      window.addEventListener("stx:navigate", syncFromUrl);
      var own = function(key) {
        var current = params();
        return Object.prototype.hasOwnProperty.call(current, key);
      };
      var commit = function(url, options) {
        var replace = !!(options && typeof options === "object" && options.replace);
        var wasPushed = !!(window.history.state && window.history.state.__stxPushed);
        if (replace)
          window.history.replaceState(wasPushed ? { __stxPushed: true } : {}, "", url);
        else
          window.history.pushState({ __stxPushed: true }, "", url);
        syncFromUrl();
      };
      return { data: params, get: function(key) {
        return own(key) ? params()[key] : undefined;
      }, has: own, set: function(key, value, options) {
        var url = new URL(window.location.href);
        url.searchParams.set(key, value);
        commit(url, options);
      }, delete: function(key, options) {
        var url = new URL(window.location.href);
        url.searchParams["delete"](key);
        commit(url, options);
      }, setAll: function(obj, options) {
        var url = new URL(window.location.href);
        Object.keys(obj).forEach(function(k) {
          url.searchParams.set(k, obj[k]);
        });
        commit(url, options);
      } };
    }
    var _queryCache = {};
    var _queryInflight = {};
    var __stxQueryInstance = 0;
    function suspenseRegistry() {
      if (typeof window === "undefined")
        return [];
      return window.__stx_suspense_registry || (window.__stx_suspense_registry = []);
    }
    function registerSuspense(loading, error) {
      var el = typeof window !== "undefined" && window.__STX_CURRENT_ELEMENT__ || null;
      suspenseRegistry().push({ el, loading, error });
    }
    function useQuery(url, options) {
      options = options || {};
      var staleTime = options.staleTime || 0;
      var cacheTime = options.cacheTime || 300000;
      var cacheKey = options.cacheKey || (typeof url === "function" ? null : url);
      var keepKey = options.keep ? typeof options.keep === "string" ? options.keep : cacheKey : null;
      var queryTarget = function() {
        var resolved = null;
        try {
          resolved = typeof url === "function" ? url() : url;
        } catch (e) {}
        return { key: cacheKey || keepKey || resolved || "", url: resolved };
      };
      var base = options.initialData || null;
      var seeded = keepKey ? __stxQueries.seed(keepKey, options.scope) : undefined;
      if (seeded)
        base = seeded.data;
      var data = state(seeded ? __stxQueries.overlay(queryTarget(), base) : base);
      var show = function(value) {
        base = value;
        data.set(__stxQueries.overlay(queryTarget(), value));
      };
      var answered = false;
      var loading = state(!seeded);
      var isFetching = state(true);
      var error = state(null);
      var isStale = state(!!seeded);
      if (options.suspense)
        registerSuspense(loading, error);
      if (keepKey && !seeded) {
        __stxQueries.restore(keepKey, options.scope).then(function(found) {
          if (!found || answered)
            return;
          show(found.data);
          loading.set(false);
          isStale.set(true);
        });
      }
      var __stxAbort = null;
      var __instanceId = ++__stxQueryInstance;
      var __joined = null;
      var fetchData = async function(runOptions) {
        var background = !!(runOptions && runOptions.background);
        var resolvedUrl = typeof url === "function" ? url() : url;
        if (!resolvedUrl) {
          if (!background)
            loading.set(false);
          isFetching.set(false);
          return;
        }
        var key = cacheKey || resolvedUrl;
        var cached = _queryCache[key];
        if (cached && Date.now() - cached.timestamp < staleTime) {
          answered = true;
          show(cached.data);
          if (!background)
            loading.set(false);
          isFetching.set(false);
          isStale.set(false);
          if (options.onSuccess)
            options.onSuccess(cached.data);
          return;
        }
        if (cached) {
          show(cached.data);
          isStale.set(true);
        }
        var shared = _queryInflight[key];
        if (shared && shared.owner !== __instanceId) {
          shared.refs++;
          __joined = shared;
          if (!background)
            loading.set(true);
          isFetching.set(true);
          if (!background)
            error.set(null);
          try {
            var joinedResult = await shared.promise;
            var joinedTransformed = options.transform ? options.transform(joinedResult) : joinedResult;
            answered = true;
            show(joinedTransformed);
            if (keepKey)
              __stxQueries.persist(keepKey, joinedTransformed, options.scope);
            if (background)
              error.set(null);
            isStale.set(false);
            if (options.onSuccess)
              options.onSuccess(joinedTransformed);
          } catch (e) {
            if (e && e.name === "AbortError")
              return;
            error.set(e.message || "Query failed");
            if (options.onError)
              options.onError(e);
          } finally {
            shared.refs--;
            if (__joined === shared)
              __joined = null;
            if (!background)
              loading.set(false);
            isFetching.set(false);
          }
          return;
        }
        if (__stxAbort) {
          if (__joined && __joined.refs > 1)
            __joined.refs--;
          else
            __stxAbort.abort();
        }
        __joined = null;
        __stxAbort = typeof AbortController !== "undefined" ? new AbortController : null;
        var __signal = __stxAbort ? __stxAbort.signal : undefined;
        if (!background)
          loading.set(true);
        isFetching.set(true);
        if (!background)
          error.set(null);
        try {
          var fetchOpts = { method: "GET", headers: { "Content-Type": "application/json", ...__stxHeaders(options.headers) }, signal: __signal };
          var netPromise = async function() {
            var response = await __stxFetch("useQuery", resolvedUrl, fetchOpts);
            if (!response.ok)
              throw await __stxHttpError(response);
            return await response.json();
          }();
          var entry = { owner: __instanceId, refs: 1, controller: __stxAbort, promise: netPromise };
          _queryInflight[key] = entry;
          __joined = entry;
          var releaseEntry = function() {
            if (_queryInflight[key] === entry)
              delete _queryInflight[key];
          };
          netPromise.then(releaseEntry, releaseEntry);
          var result = await netPromise;
          if (__signal && __signal.aborted)
            return;
          var transformed = options.transform ? options.transform(result) : result;
          answered = true;
          show(transformed);
          if (keepKey)
            __stxQueries.persist(keepKey, transformed, options.scope);
          if (background)
            error.set(null);
          isStale.set(false);
          _queryCache[key] = { data: transformed, timestamp: Date.now() };
          if (options.onSuccess)
            options.onSuccess(transformed);
          setTimeout(function() {
            delete _queryCache[key];
          }, cacheTime);
        } catch (e) {
          if (e && e.name === "AbortError")
            return;
          error.set(e.message || "Query failed");
          if (options.onError)
            options.onError(e);
        } finally {
          if (!__signal || !__signal.aborted) {
            if (!background)
              loading.set(false);
            isFetching.set(false);
          }
        }
      };
      var backgroundRun = { background: true };
      if (options.immediate !== false) {
        onMount(function() {
          return seeded ? fetchData(backgroundRun) : fetchData();
        });
      }
      var unwatch = __stxQueries.watch({ target: queryTarget, updated: function() {
        delete _queryCache[cacheKey || queryTarget().url];
        fetchData(backgroundRun);
      }, outbox: function(sent) {
        if (sent) {
          base = __stxQueries.overlay(queryTarget(), base, sent.id);
          delete _queryCache[cacheKey || queryTarget().url];
          fetchData(backgroundRun);
        }
        show(base);
      } });
      onDestroy(unwatch);
      if (options.refetchOnFocus) {
        var onVisibility = function() {
          if (!document.hidden)
            fetchData(backgroundRun);
        };
        document.addEventListener("visibilitychange", onVisibility);
        onDestroy(function() {
          document.removeEventListener("visibilitychange", onVisibility);
        });
      }
      if (options.refetchInterval) {
        var intervalId = setInterval(function() {
          if (typeof document !== "undefined" && document.hidden)
            return;
          var en = options.enabled;
          if (typeof en === "function" ? !en() : en === false)
            return;
          var p = fetchData(backgroundRun);
          if (options.stopOnError && p && typeof p.then === "function") {
            p.then(function() {
              if (error())
                clearInterval(intervalId);
            });
          }
        }, options.refetchInterval);
        onDestroy(function() {
          clearInterval(intervalId);
        });
      }
      onDestroy(function() {
        if (__stxAbort)
          __stxAbort.abort();
      });
      return { data, loading, isFetching, error, isStale, refetch: fetchData, invalidate: function(runOptions) {
        var key = cacheKey || (typeof url === "function" ? url() : url);
        delete _queryCache[key];
        return fetchData(runOptions);
      } };
    }
    function useMutation(url, options) {
      options = options || {};
      var data = state(null);
      var loading = state(false);
      var error = state(null);
      var mutate = async function(body) {
        loading.set(true);
        error.set(null);
        var previousData = data();
        if (options.optimisticData) {
          var optimistic = typeof options.optimisticData === "function" ? options.optimisticData(body) : options.optimisticData;
          data.set(optimistic);
        }
        try {
          var resolvedUrl = typeof url === "function" ? url() : url;
          var fetchOpts = { method: options.method || "POST", headers: __stxRawBody(body) ? __stxHeaders(options.headers) : { "Content-Type": "application/json", ...__stxHeaders(options.headers) }, body: typeof body === "string" || __stxRawBody(body) ? body : JSON.stringify(body) };
          var response = await __stxFetch("useMutation", resolvedUrl, fetchOpts);
          if (!response.ok)
            throw await __stxHttpError(response);
          var result = await response.json();
          var transformed = options.transform ? options.transform(result) : result;
          data.set(transformed);
          if (options.onSuccess)
            options.onSuccess(transformed);
          if (options.invalidateQueries) {
            options.invalidateQueries.forEach(function(key) {
              delete _queryCache[key];
            });
          }
          return transformed;
        } catch (e) {
          error.set(e.message || "Mutation failed");
          if (options.optimisticData)
            data.set(previousData);
          if (options.onError)
            options.onError(e);
          throw e;
        } finally {
          loading.set(false);
        }
      };
      return { data, loading, error, mutate, reset: function() {
        data.set(null);
        error.set(null);
        loading.set(false);
      } };
    }
    function useOptimistic(base, reducer) {
      var readBase = typeof base === "function" ? base : function() {
        return base;
      };
      var pending = state([]);
      var optimistic = derived(function() {
        return pending().reduce(function(acc, entry) {
          return reducer(acc, entry.action);
        }, readBase());
      });
      var primed = false;
      effect(function() {
        readBase();
        if (!primed) {
          primed = true;
          return;
        }
        if (peek(function() {
          return pending().length;
        }))
          pending.set([]);
      });
      function addOptimistic(action, settleWhen) {
        var entry = { action };
        pending.set(pending().concat([entry]));
        var settle = function() {
          var next = pending().filter(function(e) {
            return e !== entry;
          });
          if (next.length !== pending().length)
            pending.set(next);
        };
        if (settleWhen && typeof settleWhen.then === "function") {
          Promise.resolve(settleWhen).then(settle, settle);
        }
        return settle;
      }
      return [optimistic, addOptimistic];
    }
    let componentScope = { $refs: {} };
    let currentElement = null;
    function findElementScope(el) {
      let current = el;
      while (current && current !== document) {
        if (current.__stx_scope) {
          return current.__stx_scope;
        }
        if (current.hasAttribute && current.hasAttribute("data-stx-scope")) {
          const scopeId = current.getAttribute("data-stx-scope");
          if (window.stx._scopes && window.stx._scopes[scopeId]) {
            return window.stx._scopes[scopeId];
          }
        }
        current = current.parentElement || current.parentNode;
      }
      return null;
    }
    function toValue(expr, el, enableAutoUnwrap = true, extraScope = {}) {
      try {
        if (/^__[A-Z_]+__$/.test(expr.trim())) {
          return expr;
        }
        const elementScope = findElementScope(el || currentElement);
        const baseScope = { ...globalHelpers, ...componentScope, ...elementScope || {}, ...extraScope };
        const pipeResult = parsePipeExpression(expr, baseScope);
        if (pipeResult) {
          const unwrapScope = enableAutoUnwrap ? createAutoUnwrapProxy(baseScope, function(prop) {
            if (typeof prop !== "string")
              return false;
            return expressionCallsSignal(expr, prop) || expressionUsesSignalApi(expr, prop);
          }) : baseScope;
          const piped = executePipeExpression(pipeResult.valueExpr, pipeResult.pipes, unwrapScope);
          return piped && typeof piped === "function" && (piped._isSignal || piped._isDerived) ? piped() : piped;
        }
        const scope = enableAutoUnwrap ? createAutoUnwrapProxy(baseScope, function(prop) {
          if (typeof prop !== "string")
            return false;
          return expressionCallsSignal(expr, prop) || expressionUsesSignalApi(expr, prop);
        }) : baseScope;
        const fn = __stxCompileScoped(baseScope, [], "return " + expr);
        const result = fn(...__stxArgs(fn, scope));
        return result && typeof result === "function" && (result._isSignal || result._isDerived) ? result() : result;
      } catch (e) {
        if (!(e instanceof ReferenceError) && !(e instanceof TypeError))
          console.warn("[STX] Expression error:", expr, e);
        return "";
      }
    }
    function parseEventShorthand(expr, scope) {
      const trimmed = expr.trim();
      if (/^!\w+$/.test(trimmed)) {
        const varName = trimmed.slice(1);
        const signal = scope[varName];
        if (signal && signal._isSignal) {
          return () => signal.set(!signal());
        }
        return null;
      }
      if (/^\w+\+\+$/.test(trimmed)) {
        const varName = trimmed.slice(0, -2);
        const signal = scope[varName];
        if (signal && signal._isSignal) {
          return () => signal.update((n) => n + 1);
        }
        return null;
      }
      if (/^\w+--$/.test(trimmed)) {
        const varName = trimmed.slice(0, -2);
        const signal = scope[varName];
        if (signal && signal._isSignal) {
          return () => signal.update((n) => n - 1);
        }
        return null;
      }
      const assignMatch = trimmed.match(/^(\w+)\s*([+\-*\/])=\s*(.+)$/);
      if (assignMatch) {
        const [, varName, op, valueExpr] = assignMatch;
        const signal = scope[varName];
        if (signal && signal._isSignal) {
          return ($event) => {
            const addValue = toValue(valueExpr, null, true, { ...scope, $event });
            signal.update((n) => {
              switch (op) {
                case "+":
                  return n + addValue;
                case "-":
                  return n - addValue;
                case "*":
                  return n * addValue;
                case "/":
                  return n / addValue;
                default:
                  return n;
              }
            });
          };
        }
        return null;
      }
      const simpleAssignMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
      if (simpleAssignMatch && !trimmed.includes("==") && !trimmed.includes("=>")) {
        const [, varName, valueExpr] = simpleAssignMatch;
        const signal = scope[varName];
        if (signal && signal._isSignal) {
          return ($event) => {
            const newValue = toValue(valueExpr, null, true, { ...scope, $event });
            signal.set(newValue);
          };
        }
        return null;
      }
      const bareIdMatch = trimmed.match(/^([a-zA-Z_$][\w$]*)$/);
      if (bareIdMatch) {
        const fn = scope[bareIdMatch[1]];
        if (typeof fn === "function" && !fn._isSignal) {
          return ($event) => fn($event);
        }
      }
      return null;
    }
    function expressionUsesSignalApi(expression, name) {
      var escapedName = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      return expressionUsesSignalMethod(expression, name) || expressionUsesSignalValue(expression, name);
    }
    function expressionUsesSignalMethod(expression, name) {
      var escapedName = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      return new RegExp("(?:^|[^\\w$])" + escapedName + "\\s*\\.\\s*(?:set|update|subscribe|toggle|input|change)\\s*\\(").test(expression);
    }
    function expressionUsesSignalValue(expression, name) {
      var escapedName = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      return new RegExp("(?:^|[^\\w$])" + escapedName + "\\s*\\.\\s*value\\b").test(expression);
    }
    function expressionCallsSignal(expression, name) {
      var escapedName = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      return new RegExp("(?:^|[^\\w$])" + escapedName + "\\s*\\(").test(expression);
    }
    function createExpressionAutoUnwrapProxy(scope, expression) {
      return createAutoUnwrapProxy(scope, function(prop, signal) {
        if (typeof prop !== "string")
          return false;
        if (expressionCallsSignal(expression, prop) || expressionUsesSignalMethod(expression, prop))
          return true;
        if (!expressionUsesSignalValue(expression, prop))
          return false;
        try {
          var currentValue = signal();
          return !(currentValue && typeof currentValue === "object" && Object.prototype.hasOwnProperty.call(currentValue, "value"));
        } catch (e) {
          return true;
        }
      });
    }
    function executeHandler(expr, event, el) {
      try {
        if (/^__[A-Z_]+__$/.test(expr.trim())) {
          return;
        }
        const elementScope = findElementScope(el || currentElement);
        const scope = { ...globalHelpers, ...componentScope, ...elementScope || {} };
        const shorthandFn = parseEventShorthand(expr, scope);
        if (shorthandFn) {
          shorthandFn(event);
          return;
        }
        const handlerScope = {};
        Object.keys(scope).forEach(function(k) {
          const v = scope[k];
          handlerScope[k] = v && typeof v === "function" && v._isStxLoopItem ? v() : v;
        });
        const fn = __stxCompileScoped(handlerScope, ["$event"], expr);
        fn(...__stxArgs(fn, handlerScope), event);
      } catch (e) {
        console.warn("[STX] Handler error:", expr, e);
      }
    }
    function deferHydration(el, trigger, scope) {
      if (el.__stx_hydration_scheduled)
        return;
      el.__stx_hydration_scheduled = true;
      var run = function() {
        if (el.__stx_hydrated)
          return;
        el.__stx_hydrated = true;
        el.__stx_hydration_cancel = null;
        el.removeAttribute("stx-hydrate");
        var sid = el.getAttribute && el.getAttribute("data-stx-scope");
        var finishHydrate = function() {
          var effectiveScope = scope;
          if (sid) {
            var reg = window.stx._scopes ? window.stx._scopes[sid] : null;
            if (reg)
              effectiveScope = Object.assign({}, scope || {}, reg);
          }
          Array.from(el.children).forEach(function(child) {
            processElement(child, effectiveScope);
          });
          processAttributesOnly(el, effectiveScope);
          var sv = sid && window.stx._scopes ? window.stx._scopes[sid] : null;
          if (sv && sv.__mountCallbacks && !sv.__mounted) {
            sv.__mounted = true;
            runMountCallbacks(sv.__mountCallbacks, scopeDestroySink(sv));
          }
          window.dispatchEvent(new CustomEvent("stx:hydrated", { detail: { el, trigger } }));
        };
        var islandScript = sid ? document.querySelector('script[data-stx-island="' + sid + '"]') : null;
        if (islandScript && !islandScript.__stx_ran) {
          islandScript.__stx_ran = true;
          var chunkSrc = islandScript.getAttribute && islandScript.getAttribute("data-stx-src");
          if (chunkSrc) {
            var s = document.createElement("script");
            s.src = chunkSrc;
            var integ = islandScript.getAttribute("data-stx-integrity");
            if (integ)
              s.integrity = integ;
            s.onload = finishHydrate;
            s.onerror = function() {
              console.error("[stx] island chunk load failed:", sid, chunkSrc);
              window.dispatchEvent(new CustomEvent("stx:island-error", { detail: { el, scopeId: sid, src: chunkSrc } }));
              finishHydrate();
            };
            document.head.appendChild(s);
            return;
          }
          try {
            new Function(islandScript.textContent)();
          } catch (e) {
            console.error("[stx] island setup error:", sid, e);
          }
        }
        finishHydrate();
      };
      if (trigger === "idle") {
        if (typeof requestIdleCallback === "function") {
          var idleId = requestIdleCallback(run, { timeout: 2000 });
          el.__stx_hydration_cancel = function() {
            if (typeof cancelIdleCallback === "function")
              cancelIdleCallback(idleId);
          };
        } else {
          var idleTimer = setTimeout(run, 200);
          el.__stx_hydration_cancel = function() {
            clearTimeout(idleTimer);
          };
        }
      } else if (trigger === "visible") {
        if (typeof IntersectionObserver === "function") {
          var io = new IntersectionObserver(function(entries) {
            entries.forEach(function(e) {
              if (e.isIntersecting) {
                io.disconnect();
                run();
              }
            });
          }, { rootMargin: "50px" });
          io.observe(el);
          el.__stx_hydration_cancel = function() {
            io.disconnect();
          };
        } else {
          run();
        }
      } else if (trigger === "interaction") {
        var events = ["mouseenter", "click", "focusin", "touchstart"];
        var handler = function() {
          events.forEach(function(ev) {
            el.removeEventListener(ev, handler);
          });
          run();
        };
        events.forEach(function(ev) {
          el.addEventListener(ev, handler, { once: true, passive: true });
        });
        el.__stx_hydration_cancel = function() {
          events.forEach(function(ev) {
            el.removeEventListener(ev, handler);
          });
        };
      } else if (trigger && trigger.indexOf("media:") === 0) {
        var query = trigger.slice(6);
        var mql = window.matchMedia(query);
        if (mql.matches)
          run();
        else {
          var mqHandler = function(e) {
            if (e.matches) {
              mql.removeEventListener("change", mqHandler);
              run();
            }
          };
          mql.addEventListener("change", mqHandler);
          el.__stx_hydration_cancel = function() {
            mql.removeEventListener("change", mqHandler);
          };
        }
      } else {
        run();
      }
    }
    function processAttributesOnly(el, scope) {
      el.__stx_hydrated = true;
      processElement(el, scope);
    }
    function isForDirectiveExpression(expr) {
      return typeof expr === "string" && /^\s*\(?\s*\w+(?:\s*,\s*\w+)?\s*\)?\s+(?:in|of)\s+.+\s*$/.test(expr);
    }
    function getElementAttributes(el) {
      if (!el || !el.attributes)
        return [];
      return Array.from(el.attributes).map(function(attr) {
        if (Array.isArray(attr))
          return { name: attr[0], value: attr[1] };
        return attr;
      });
    }
    function getModelBinding(el) {
      if (!el || !el.attributes)
        return null;
      var prefixes = ["x-model", ":model", "@model"];
      var attrs = getElementAttributes(el);
      for (var i = 0;i < attrs.length; i++) {
        var name = attrs[i] && attrs[i].name;
        if (!name)
          continue;
        for (var j = 0;j < prefixes.length; j++) {
          if (name === prefixes[j] || name.indexOf(prefixes[j] + ".") === 0)
            return { name, expression: attrs[i].value };
        }
      }
      return null;
    }
    function readDeferredParentComponentProps(el) {
      var serialized = el.getAttribute("data-stx-deferred-parent-bindings");
      if (!serialized)
        return {};
      try {
        var parsed = JSON.parse(serialized);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch (e) {
        return {};
      }
    }
    function preserveDeferredParentComponentProps(el) {
      var names = (el.getAttribute("data-stx-parent-bindings") || "").split(/\s+/).filter(Boolean);
      if (!names.length)
        return;
      var deferred = readDeferredParentComponentProps(el);
      names.forEach(function(name) {
        var sourceName = ":" + name;
        if (el.hasAttribute(sourceName))
          deferred[name] = el.getAttribute(sourceName);
      });
      if (Object.keys(deferred).length)
        el.setAttribute("data-stx-deferred-parent-bindings", JSON.stringify(deferred));
    }
    function hasPendingLoopBoundary(el) {
      var loopBoundary = el;
      while (loopBoundary && loopBoundary !== document) {
        var loopExpression = loopBoundary.getAttribute && (loopBoundary.getAttribute("@for") || loopBoundary.getAttribute(":for") || loopBoundary.getAttribute("x-for"));
        if (loopExpression && isForDirectiveExpression(loopExpression))
          return true;
        loopBoundary = loopBoundary.parentElement || loopBoundary.parentNode;
      }
      return false;
    }
    function hasPendingAncestorLoopBoundary(el) {
      var loopBoundary = el && (el.parentElement || el.parentNode);
      while (loopBoundary && loopBoundary !== document) {
        var loopExpression = loopBoundary.getAttribute && (loopBoundary.getAttribute("@for") || loopBoundary.getAttribute(":for") || loopBoundary.getAttribute("x-for"));
        if (loopExpression && isForDirectiveExpression(loopExpression))
          return true;
        loopBoundary = loopBoundary.parentElement || loopBoundary.parentNode;
      }
      return false;
    }
    function syncComponentPropSignal(el, name, value) {
      if (!el || !el.getAttribute || value === undefined)
        return;
      var scopeId = el.getAttribute("data-stx-scope");
      var scopeVars = scopeId && window.stx._scopes && window.stx._scopes[scopeId];
      var camelName = name.replace(/-([a-z0-9])/g, function(_, character) {
        return character.toUpperCase();
      });
      var propSignals = el.__stx_reactive_prop_signals;
      var propSignal = propSignals && (propSignals[name] || propSignals[camelName]);
      if (!propSignal && scopeVars)
        propSignal = scopeVars[name] || scopeVars[camelName];
      if (!propSignal || !propSignal._isSignal || typeof propSignal.set !== "function")
        return;
      var directValues = el.__stx_direct_prop_values || (el.__stx_direct_prop_values = {});
      var directValue = { raw: el.hasAttribute(name) ? el.getAttribute(name) : null, value };
      directValues[name] = directValue;
      directValues[camelName] = directValue;
      if (!Object.is(peek(function() {
        return propSignal();
      }), value))
        propSignal.set(value);
    }
    function bindParentComponentProps(el, callerScope) {
      if (!el || !el.getAttribute || el.__stx_parent_props_bound)
        return;
      var names = (el.getAttribute("data-stx-parent-bindings") || "").split(/\s+/).filter(Boolean);
      if (!names.length)
        return;
      if (hasPendingLoopBoundary(el)) {
        preserveDeferredParentComponentProps(el);
        return;
      }
      var deferred = readDeferredParentComponentProps(el);
      var bindings = names.map(function(name) {
        var sourceName = ":" + name;
        var expression = el.hasAttribute(sourceName) ? el.getAttribute(sourceName) : deferred[name];
        return typeof expression === "string" ? { name, sourceName, expression } : null;
      }).filter(Boolean);
      if (!bindings.length)
        return;
      el.__stx_parent_props_bound = true;
      var scope = { ...globalHelpers, ...callerScope };
      bindings.forEach(function(binding) {
        var name = binding.name;
        var sourceName = binding.sourceName;
        var expression = binding.expression;
        effect(function() {
          var value;
          try {
            var unwrapScope = createAutoUnwrapProxy(scope, function(prop) {
              if (typeof prop !== "string")
                return false;
              return expressionCallsSignal(expression, prop) || expressionUsesSignalApi(expression, prop);
            });
            var fn = __stxCompileScoped(unwrapScope, [], "return (" + expression + ")");
            value = fn(...__stxArgs(fn, unwrapScope));
            if (value && typeof value === "function" && (value._isSignal || value._isDerived))
              value = value();
          } catch (e) {
            if (!(e instanceof ReferenceError) && !(e instanceof TypeError))
              console.warn("[STX] Parent component prop error:", expression, e);
            value = undefined;
          }
          if (name.startsWith("aria-") && typeof value === "boolean") {
            stxHost.setAttribute(el, name, String(value));
          } else if (value === null || value === undefined) {
            stxHost.removeAttribute(el, name);
          } else {
            stxHost.setAttribute(el, name, value);
          }
          syncComponentPropSignal(el, name, value);
        });
        el.removeAttribute(sourceName);
        delete deferred[name];
      });
      if (Object.keys(deferred).length)
        el.setAttribute("data-stx-deferred-parent-bindings", JSON.stringify(deferred));
      else
        el.removeAttribute("data-stx-deferred-parent-bindings");
    }
    function resolveComponentCallerScope(el, pageScope) {
      var resolved = { ...pageScope };
      var ancestors = [];
      var current = el && (el.parentElement || el.parentNode);
      while (current && current !== document) {
        if (current.getAttribute && current.hasAttribute("data-stx-scope"))
          ancestors.push(current.getAttribute("data-stx-scope"));
        current = current.parentElement || current.parentNode;
      }
      ancestors.reverse().forEach(function(scopeId) {
        var ancestorScope = window.stx._scopes && window.stx._scopes[scopeId];
        if (ancestorScope)
          Object.assign(resolved, ancestorScope);
      });
      return resolved;
    }
    function preserveConditionalComponentScopes(root, callerScope) {
      if (!root || !root.querySelectorAll)
        return;
      var scopeEls = [];
      if (root.matches && root.matches("[data-stx-scope]"))
        scopeEls.push(root);
      root.querySelectorAll("[data-stx-scope]").forEach(function(scopeEl) {
        scopeEls.push(scopeEl);
      });
      scopeEls.forEach(function(scopeEl) {
        if (scopeEl.__stx_parent_props_bound)
          return;
        var current = scopeEl;
        while (current && current !== root) {
          if (current.hasAttribute && (current.hasAttribute("@for") || current.hasAttribute(":for") || current.hasAttribute("x-for"))) {
            preserveDeferredParentComponentProps(scopeEl);
            return;
          }
          current = current.parentElement || current.parentNode;
        }
        scopeEl.__stx_parent_scope = resolveComponentCallerScope(scopeEl, callerScope);
        bindParentComponentProps(scopeEl, scopeEl.__stx_parent_scope);
      });
    }
    function findConditionalComponentSetupSiblings(root) {
      if (!root || !root.hasAttribute || !root.hasAttribute("data-stx-scope"))
        return [];
      var scopeId = root.getAttribute("data-stx-scope");
      var templateScopeId = root.getAttribute("data-stx-template-scope") || scopeId;
      if (!scopeId)
        return [];
      var scripts = [];
      var sibling = root.nextSibling;
      while (sibling) {
        var next = sibling.nextSibling;
        if (sibling.nodeType === Node.TEXT_NODE && !(sibling.textContent || "").trim()) {
          sibling = next;
          continue;
        }
        if (sibling.nodeType === Node.COMMENT_NODE) {
          sibling = next;
          continue;
        }
        if (sibling.nodeType === Node.ELEMENT_NODE && sibling.tagName === "STYLE" && sibling.hasAttribute("data-stx-vendor")) {
          sibling = next;
          continue;
        }
        if (sibling.nodeType === Node.ELEMENT_NODE && sibling.tagName === "SCRIPT" && sibling.hasAttribute("data-stx-scoped") && ((sibling.textContent || "").indexOf(scopeId) !== -1 || templateScopeId && (sibling.textContent || "").indexOf(templateScopeId) !== -1)) {
          scripts.push(sibling);
          sibling = next;
          continue;
        }
        break;
      }
      return scripts;
    }
    function processFromManifest(root, scope, manifest, resolvedNodes) {
      var entries = Array.isArray(manifest) ? manifest : manifest && Array.isArray(manifest.entries) ? manifest.entries : null;
      if (!entries || !entries.length || !root && !resolvedNodes)
        return false;
      for (var i = 0;i < entries.length; i++) {
        var entry = entries[i];
        var id = entry && entry.id;
        if (id === undefined || id === null)
          continue;
        var node = resolvedNodes ? typeof resolvedNodes.get === "function" ? resolvedNodes.get(id) : resolvedNodes[id] : null;
        if (!node && root) {
          node = root.getAttribute && root.getAttribute("data-stx-b") === String(id) ? root : root.querySelector ? root.querySelector('[data-stx-b="' + id + '"]') : null;
        }
        if (!node)
          continue;
        if (resolvedNodes && node.__stxId !== undefined && node.isConnected === false)
          continue;
        processElement(node, scope, true);
      }
      return true;
    }
    function hydrateHost(root, setup, manifest, resolvedNodes) {
      var mountStart = mountCallbacks.length;
      var destroyStart = destroyCallbacks.length;
      var outerSink = activeDestroySink;
      activeDestroySink = null;
      var values;
      try {
        values = typeof setup === "function" ? setup() : setup;
      } finally {
        activeDestroySink = outerSink;
      }
      var localMountHooks = mountCallbacks.splice(mountStart);
      var localDestroyHooks = destroyCallbacks.splice(destroyStart);
      var scope = Object.assign({ $refs: {} }, values || {});
      var disposeEffects = trackEffects(function() {
        processFromManifest(root, scope, manifest, resolvedNodes);
      });
      runMountCallbacks(localMountHooks, localDestroyHooks);
      var mounted = true;
      return function disposeHost() {
        if (!mounted)
          return;
        mounted = false;
        disposeEffects();
        var hooks = localDestroyHooks.splice(0, localDestroyHooks.length);
        for (var i = 0;i < hooks.length; i++) {
          try {
            hooks[i]();
          } catch (e) {
            console.warn("[stx] native destroy error:", e);
          }
        }
      };
    }
    function processElement(el, scope = componentScope, skipChildren) {
      if (el.nodeType === Node.ELEMENT_NODE && el.hasAttribute && el.hasAttribute("stx-hydrate") && !el.__stx_hydrated) {
        var trigger = el.getAttribute("stx-hydrate") || "idle";
        deferHydration(el, trigger, scope);
        return;
      }
      if (el.nodeType === Node.ELEMENT_NODE && el.hasAttribute && el.hasAttribute("data-stx-scope") && hasPendingAncestorLoopBoundary(el)) {
        preserveDeferredParentComponentProps(el);
        return;
      }
      if (el.nodeType === Node.ELEMENT_NODE && el.tagName === "BUTTON" && el.hasAttribute && el.hasAttribute("@click")) {}
      if (el.nodeType === Node.ELEMENT_NODE && el.hasAttribute) {
        if (el.hasAttribute("x-data") || el.hasAttribute("data-stx-xdata") || el.__stx_scope) {
          var xdScope = el.__stx_scope || (findElementScope(el) || {});
          if (xdScope && Object.keys(xdScope).length > 0) {
            scope = { ...scope, ...xdScope };
          }
        }
        if (el.hasAttribute("data-stx-memo")) {
          var memoExpr = el.getAttribute("data-stx-memo");
          try {
            var memoScope = { ...globalHelpers, ...scope, ...findElementScope(el) || {} };
            var memoFn = __stxCompileScoped(memoScope, [], "return " + memoExpr);
            var memoVals = JSON.stringify(memoFn(...__stxArgs(memoFn, memoScope)));
            if (el.__stx_memo_prev === memoVals) {
              return;
            }
            el.__stx_memo_prev = memoVals;
          } catch (e) {}
        }
      }
      if (el.nodeType === Node.TEXT_NODE) {
        const text = el.textContent == null ? "" : String(el.textContent);
        if (text && text.includes("{{")) {
          const parts = text.split(/(\{\{[\s\S]+?\}\})/g);
          if (parts.length > 1) {
            const fragment = document.createDocumentFragment();
            const parentEl = el.parentNode;
            const capturedScope = { ...globalHelpers, ...scope, ...findElementScope(parentEl) || {} };
            parts.forEach((part) => {
              const match = part.match(/^\{\{\s*([\s\S]+?)\s*\}\}$/);
              if (match) {
                const expr = match[1];
                if (/^__[A-Z_]+__$/.test(expr.trim())) {
                  fragment.appendChild(document.createTextNode(part));
                  return;
                }
                const isTextOnlyParent = parentEl && (parentEl.tagName === "OPTION" || parentEl.tagName === "TITLE" || parentEl.tagName === "TEXTAREA");
                const bindingNode = isTextOnlyParent ? document.createTextNode("") : document.createElement("span");
                fragment.appendChild(bindingNode);
                effect(() => {
                  try {
                    const pipeResult = parsePipeExpression(expr, capturedScope);
                    if (pipeResult) {
                      const unwrapScope = createExpressionAutoUnwrapProxy(capturedScope, expr);
                      bindingNode.textContent = executePipeExpression(pipeResult.valueExpr, pipeResult.pipes, unwrapScope);
                    } else {
                      const unwrapScope = createExpressionAutoUnwrapProxy(capturedScope, expr);
                      const fn = __stxCompileScoped(capturedScope, [], "return " + expr);
                      bindingNode.textContent = fn(...__stxArgs(fn, unwrapScope));
                    }
                  } catch (e) {
                    try {
                      const fn = __stxCompileScoped(capturedScope, [], "return " + expr);
                      bindingNode.textContent = fn(...__stxArgs(fn, capturedScope));
                    } catch (e2) {
                      if (!(e2 instanceof ReferenceError) && !(e2 instanceof TypeError))
                        console.warn("[STX] Expression error:", expr, e2);
                      bindingNode.textContent = "";
                    }
                  }
                });
              } else if (part) {
                fragment.appendChild(document.createTextNode(part));
              }
            });
            el.replaceWith(fragment);
          }
        }
        return;
      }
      if (el.nodeType !== Node.ELEMENT_NODE)
        return;
      if (el.hasAttribute("data-stx-suspense") && !el.__stx_suspense_bound) {
        bindSuspense(el, scope);
        return;
      }
      var hasColonForLoop = el.hasAttribute(":for") && isForDirectiveExpression(el.getAttribute(":for"));
      if (el.hasAttribute("@for") || hasColonForLoop || el.hasAttribute("x-for")) {
        var forAttr = hasColonForLoop ? ":for" : el.hasAttribute("x-for") ? "x-for" : "@for";
        bindFor(el, scope, forAttr);
        return;
      }
      if (el.__stx_chain_member && !el.__stx_chain_active)
        return;
      if (!el.__stx_chain_member) {
        var orphanElse = getElseAttrInfo(el);
        if (orphanElse) {
          console.warn("[STX] " + orphanElse.name + " has no matching preceding x-if/:if/@if sibling; rendering as a plain element.");
          el.removeAttribute(orphanElse.name);
        }
      }
      if (el.hasAttribute("@if") || el.hasAttribute(":if") || el.hasAttribute("x-if")) {
        var ifAttr = el.hasAttribute(":if") ? ":if" : el.hasAttribute("x-if") ? "x-if" : "@if";
        var ifChain = findIfChain(el, ifAttr);
        if (ifChain.length > 1)
          bindIfChain(ifChain, scope);
        else
          bindIf(el, scope, ifAttr);
        return;
      }
      if (el.hasAttribute("@show") || el.hasAttribute(":show") || el.hasAttribute("x-show")) {
        var showAttr = el.hasAttribute(":show") ? ":show" : el.hasAttribute("x-show") ? "x-show" : "@show";
        bindShow(el, el.getAttribute(showAttr), scope, showAttr);
      }
      var modelBinding = getModelBinding(el);
      if (modelBinding) {
        bindModel(el, modelBinding.expression, scope, modelBinding.name);
      }
      const attrCapturedScope = { ...globalHelpers, ...scope, ...findElementScope(el) || {} };
      const attrVisibility = [];
      for (var attrAncestor = el;attrAncestor; attrAncestor = attrAncestor.parentNode) {
        if (attrAncestor.__stx_if_visible)
          attrVisibility.push(attrAncestor.__stx_if_visible);
      }
      function attributesVisible() {
        return attrVisibility.every(function(visible) {
          return visible();
        });
      }
      const maybeUnwrapSignal = (v) => {
        if (v && typeof v === "function" && (v._isSignal || v._isDerived))
          return v();
        return v;
      };
      const evalAttrExpr = (rawExpr, evaluationScope) => {
        const activeScope = evaluationScope || attrCapturedScope;
        var expr = rawExpr.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
        try {
          if (/^__[A-Z_]+__$/.test(expr.trim()))
            return expr;
          const pipeResult = parsePipeExpression(expr, activeScope);
          if (pipeResult) {
            const unwrapScope = createExpressionAutoUnwrapProxy(activeScope, expr);
            var piped = maybeUnwrapSignal(executePipeExpression(pipeResult.valueExpr, pipeResult.pipes, unwrapScope));
            noteExprSuccess(expr);
            return piped;
          }
          const unwrapScope = createExpressionAutoUnwrapProxy(activeScope, expr);
          const fn = __stxCompileScoped(unwrapScope, [], "return (" + expr + ")");
          var value = maybeUnwrapSignal(fn(...__stxArgs(fn, unwrapScope)));
          noteExprSuccess(expr);
          return value;
        } catch (e) {
          try {
            const fn = __stxCompileScoped(activeScope, [], "return (" + expr + ")");
            var retried = maybeUnwrapSignal(fn(...__stxArgs(fn, activeScope)));
            noteExprSuccess(expr);
            return retried;
          } catch (e2) {
            if (!(e2 instanceof ReferenceError) && !(e2 instanceof TypeError))
              console.warn("[STX] Attribute expression error:", expr, e2);
            else
              noteExprFailure(expr, e2);
            return "";
          }
        }
      };
      var DIRECTIVE_NAMES = { class: 1, style: 1, text: 1, html: 1, show: 1, model: 1, if: 1, ref: 1 };
      var URL_NAV_ATTR = { href: 1, "xlink:href": 1, action: 1, formaction: 1, ping: 1, cite: 1, manifest: 1, data: 1, to: 1 };
      var URL_FETCH_ATTR = { src: 1, srcset: 1, poster: 1, background: 1 };
      var urlRefusalWarned = false;
      function safeUrlAttr(attrName, value) {
        var navigable = URL_NAV_ATTR[attrName];
        if (!navigable && !URL_FETCH_ATTR[attrName])
          return value;
        if (typeof value !== "string" || !value)
          return value;
        var probe = value.replace(/[\u0000-\u0020\u00a0\u2000-\u200f\u2028\u2029\ufeff]+/g, "").toLowerCase();
        var refused = /^(?:javascript|vbscript|livescript|mocha|view-source):/.test(probe) || (navigable ? /^data:(?:text\/html|text\/xml|application\/xhtml\+xml|application\/xml|image\/svg\+xml)/.test(probe) : /^data:(?:text\/html|application\/xhtml\+xml)/.test(probe));
        if (!refused)
          return value;
        if (!urlRefusalWarned) {
          urlRefusalWarned = true;
          console.warn("[stx] refused a " + attrName + " value whose scheme can run script: " + probe.slice(0, 24));
        }
        return "unsafe:" + value;
      }
      var SVG_ATTR_CASE = { attributename: "attributeName", attributetype: "attributeType", basefrequency: "baseFrequency", baseprofile: "baseProfile", calcmode: "calcMode", clippathunits: "clipPathUnits", diffuseconstant: "diffuseConstant", edgemode: "edgeMode", filterunits: "filterUnits", glyphref: "glyphRef", gradienttransform: "gradientTransform", gradientunits: "gradientUnits", kernelmatrix: "kernelMatrix", kernelunitlength: "kernelUnitLength", keypoints: "keyPoints", keysplines: "keySplines", keytimes: "keyTimes", lengthadjust: "lengthAdjust", limitingconeangle: "limitingConeAngle", markerheight: "markerHeight", markerunits: "markerUnits", markerwidth: "markerWidth", maskcontentunits: "maskContentUnits", maskunits: "maskUnits", numoctaves: "numOctaves", pathlength: "pathLength", patterncontentunits: "patternContentUnits", patterntransform: "patternTransform", patternunits: "patternUnits", pointsatx: "pointsAtX", pointsaty: "pointsAtY", pointsatz: "pointsAtZ", preservealpha: "preserveAlpha", preserveaspectratio: "preserveAspectRatio", primitiveunits: "primitiveUnits", refx: "refX", refy: "refY", repeatcount: "repeatCount", repeatdur: "repeatDur", requiredextensions: "requiredExtensions", requiredfeatures: "requiredFeatures", specularconstant: "specularConstant", specularexponent: "specularExponent", spreadmethod: "spreadMethod", startoffset: "startOffset", stddeviation: "stdDeviation", stitchtiles: "stitchTiles", surfacescale: "surfaceScale", systemlanguage: "systemLanguage", tablevalues: "tableValues", targetx: "targetX", targety: "targetY", textlength: "textLength", viewbox: "viewBox", viewtarget: "viewTarget", xchannelselector: "xChannelSelector", ychannelselector: "yChannelSelector", zoomandpan: "zoomAndPan" };
      var SVG_NS = "http://www.w3.org/2000/svg";
      var EVENT_RE = /^(click|dblclick|mousedown|mouseup|mousemove|mouseenter|mouseleave|keydown|keyup|keypress|input|change|submit|focus|blur|scroll|resize|touchstart|touchend|touchmove|contextmenu|wheel|pointerdown|pointerup|pointermove)(?:\.|$)/;
      var KEY_MAP = { enter: "Enter", tab: "Tab", escape: "Escape", space: " ", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", delete: "Delete", backspace: "Backspace" };
      getElementAttributes(el).forEach((attr) => {
        const name = attr.name;
        const value = attr.value;
        if (!name)
          return;
        if (name.startsWith("::")) {
          el.removeAttribute(name);
          el.setAttribute(name.slice(1), value);
          return;
        }
        var X_HANDLED = { "x-text": 1, "x-html": 1, "x-model": 1, "x-show": 1, "x-if": 1, "x-for": 1, "x-cloak": 1, "x-ref": 1, "x-data": 1, "x-bind": 1, "x-class": 1, "x-style": 1, "x-tooltip": 1, "x-tooltip-position": 1 };
        if (name.startsWith("@bind:") || name.startsWith("x-bind:") || name.startsWith(":") && !name.startsWith("::") && !DIRECTIVE_NAMES[name.slice(1).split(".")[0]] && !EVENT_RE.test(name.slice(1)) || name.startsWith("x-") && !X_HANDLED[name.split(".")[0]] && !X_HANDLED[name]) {
          let attrName = name.startsWith("@bind:") ? name.slice(6) : name.startsWith("x-bind:") ? name.slice(7) : name.startsWith("x-") ? name.slice(2) : name.slice(1);
          if (el.namespaceURI === SVG_NS && SVG_ATTR_CASE[attrName])
            attrName = SVG_ATTR_CASE[attrName];
          var parentBindingNames = (el.getAttribute && el.getAttribute("data-stx-parent-bindings") || "").split(/\s+/);
          var bindingScope = el.__stx_parent_scope && parentBindingNames.includes(attrName) ? el.__stx_parent_scope : attrCapturedScope;
          effect(() => {
            if (!attributesVisible())
              return;
            const v = evalAttrExpr(value, bindingScope);
            if (attrName === "value" && "value" in el) {
              var controlValue = v;
              if (typeof v === "object" && v !== null) {
                try {
                  controlValue = JSON.stringify(v);
                } catch (e) {
                  controlValue = String(v);
                }
              }
              controlValue = v === false || v === null || v === undefined ? "" : String(controlValue);
              el.__stx_bound_value = controlValue;
              var applyControlValue = function() {
                if (!attributesVisible())
                  return;
                var desiredValue = el.__stx_bound_value == null ? "" : String(el.__stx_bound_value);
                el.value = desiredValue;
                if (desiredValue === "" && el.tagName !== "OPTION")
                  el.removeAttribute(attrName);
                else if (el.getAttribute(attrName) !== desiredValue)
                  el.setAttribute(attrName, desiredValue);
                if (typeof el.__stx_model_sync === "function")
                  el.__stx_model_sync();
              };
              applyControlValue();
              if (el.tagName === "SELECT" && !el.__stx_value_observer && typeof window.MutationObserver !== "undefined") {
                el.__stx_value_observer = new window.MutationObserver(applyControlValue);
                el.__stx_value_observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["value"] });
                el.__stx_destroy = el.__stx_destroy || [];
                el.__stx_destroy.push(function() {
                  if (el.__stx_value_observer)
                    el.__stx_value_observer.disconnect();
                  el.__stx_value_observer = null;
                });
              }
              return;
            }
            if ((attrName === "checked" || attrName === "selected" || attrName === "indeterminate") && attrName in el) {
              var selectedState = Boolean(v);
              el[attrName] = selectedState;
              if (attrName === "indeterminate") {
                el.removeAttribute(attrName);
              } else if (selectedState) {
                el.setAttribute(attrName, "");
              } else {
                el.removeAttribute(attrName);
              }
              return;
            }
            if (attrName.startsWith("aria-") && typeof v === "boolean") {
              stxHost.setAttribute(el, attrName, String(v));
            } else if (typeof v === "boolean") {
              stxHost.setAttribute(el, attrName, v);
            } else if (v === null || v === undefined) {
              stxHost.removeAttribute(el, attrName);
            } else {
              var attrValue = v;
              if (typeof v === "object") {
                try {
                  attrValue = JSON.stringify(v);
                } catch (e) {
                  attrValue = String(v);
                }
              }
              var attrValueSafe = safeUrlAttr(attrName, attrValue);
              var hostValue = typeof v === "object" && v !== null ? v : attrValueSafe;
              if (el.getAttribute(attrName) === String(attrValueSafe))
                return;
              var parentNode = el.parentNode;
              if (attrName === "src" && el.tagName === "IFRAME" && parentNode && el.isConnected && el.hasAttribute("src") && el.getAttribute("src") !== String(attrValueSafe)) {
                var nextSibling = el.nextSibling;
                parentNode.removeChild(el);
                stxHost.setAttribute(el, attrName, hostValue);
                parentNode.insertBefore(el, nextSibling);
              } else {
                stxHost.setAttribute(el, attrName, hostValue);
              }
            }
          });
          el.removeAttribute(name);
        } else if (name === "@class" || name === ":class" || name === "x-class") {
          bindClass(el, value, scope, attributesVisible);
          el.removeAttribute(name);
        } else if (name === "@style" || name === ":style" || name === "x-style") {
          bindStyle(el, value, scope, attributesVisible);
          el.removeAttribute(name);
        } else if (name === "@text" || name === ":text" || name === "x-text") {
          effect(() => {
            stxHost.setText(el, evalAttrExpr(value));
          });
          el.removeAttribute(name);
        } else if (name === "@html" || name === ":html" || name === "x-html") {
          effect(() => {
            el.innerHTML = evalAttrExpr(value) ?? "";
          });
          el.removeAttribute(name);
        } else if (name === "ref" || name === ":ref" || name === "x-ref" || name === "data-stx-ref") {
          var refRoot = stxHost.scopeOf(el);
          var refCaller = el.getAttribute("data-stx-ref-caller");
          var refOwnerScope = findElementScope(el);
          if (refCaller) {
            var receiver = refRoot;
            while (receiver && receiver.getAttribute("data-stx-scope") !== refCaller && receiver.getAttribute("data-stx-template-scope") !== refCaller) {
              receiver = stxHost.scopeOf(receiver, true);
            }
            refOwnerScope = receiver && receiver.__stx_parent_scope;
          }
          if (refCaller && refOwnerScope) {
            if (refOwnerScope.$refs)
              refOwnerScope.$refs[value] = el;
          } else {
            if (scope.$refs)
              scope.$refs[value] = el;
            if (componentScope.$refs)
              componentScope.$refs[value] = el;
          }
          var refTarget = refCaller && refOwnerScope ? refOwnerScope[value] : scope && scope[value] || componentScope[value];
          if (refTarget && typeof refTarget === "function" && refTarget._isSignal && typeof refTarget.set === "function") {
            refTarget.set(el);
          }
        } else if (name.startsWith("@") || name.startsWith(":")) {
          const parts = name.slice(1).split(".");
          const parentEventNames = (el.getAttribute && el.getAttribute("data-stx-parent-events") || "").split(/\s+/);
          const eventName = parentEventNames.find(function(event) {
            return event.toLowerCase() === parts[0].toLowerCase();
          }) || parts[0];
          const modifiers = parts.slice(1);
          if (["if", "for", "show", "model", "class", "style", "text", "html", "ref"].includes(eventName)) {
            return;
          }
          var eventKey = "__stx_evt_" + eventName + "_" + value.substring(0, 20);
          if (el[eventKey]) {
            el.removeAttribute(name);
            return;
          }
          el[eventKey] = true;
          const isForwardedComponentEvent = !!(el.__stx_parent_scope && parentEventNames.includes(eventName));
          const eventCapturedScope = isForwardedComponentEvent ? { ...globalHelpers, ...el.__stx_parent_scope } : { ...globalHelpers, ...scope, ...findElementScope(el) || {} };
          stxHost.listen(el, eventName, (event) => {
            var componentEmits = el.__stx_component_emits;
            if (isForwardedComponentEvent && event.target !== el && componentEmits && componentEmits[eventName])
              return;
            var handlerEvent = isForwardedComponentEvent && event instanceof CustomEvent ? event.detail : event;
            if (eventName === "click") {
              var ancestor = el;
              while (ancestor) {
                if (ancestor.__stx_shown_at && performance.now() - ancestor.__stx_shown_at < 50 && !(ancestor.contains && ancestor.contains(event.target)))
                  return;
                ancestor = ancestor.parentElement;
              }
            }
            if (modifiers.includes("self") && event.target !== el)
              return;
            if (modifiers.includes("ctrl") && !event.ctrlKey)
              return;
            if (modifiers.includes("alt") && !event.altKey)
              return;
            if (modifiers.includes("shift") && !event.shiftKey)
              return;
            if (modifiers.includes("meta") && !event.metaKey)
              return;
            for (var mi = 0;mi < modifiers.length; mi++) {
              if (KEY_MAP[modifiers[mi]] && event.key !== KEY_MAP[modifiers[mi]])
                return;
            }
            if (modifiers.includes("prevent"))
              event.preventDefault();
            if (modifiers.includes("stop"))
              event.stopPropagation();
            try {
              if (!value || /^__[A-Z_]+__$/.test(value.trim()))
                return;
              var shorthandFn = parseEventShorthand(value, eventCapturedScope);
              if (shorthandFn) {
                shorthandFn(handlerEvent);
                return;
              }
              var hasSignals = Object.values(eventCapturedScope).some(function(v) {
                return v && typeof v === "function" && v._isSignal;
              });
              var isDirectAssignment = hasSignals && /^[a-zA-Z_$]\w*\s*=/.test(value.trim()) && !value.trim().startsWith("==");
              if (isDirectAssignment) {
                var getVars = Object.keys(eventCapturedScope).map(function(k) {
                  return "var " + k + ' = __s["' + k + '"] && typeof __s["' + k + '"] === "function" && __s["' + k + '"]._isSignal ? __s["' + k + '"]() : __s["' + k + '"]';
                }).join(";");
                var setVars = Object.keys(eventCapturedScope).filter(function(k) {
                  var v = eventCapturedScope[k];
                  return v && typeof v === "function" && v._isSignal;
                }).map(function(k) {
                  return "if(" + k + ' !== __s["' + k + '"]()) __s["' + k + '"].set(' + k + ")";
                }).join(";");
                var body = getVars + ";" + value + ";" + setVars;
                var fn2 = __stxCompile(["__s", "$event"], body);
                fn2(eventCapturedScope, handlerEvent);
              } else if (hasSignals) {
                var unwrapVars = Object.keys(eventCapturedScope).map(function(k) {
                  var v = eventCapturedScope[k];
                  if (v && typeof v === "function" && v._isSignal && !v._isStxLoopItem && (expressionCallsSignal(value, k) || expressionUsesSignalApi(value, k))) {
                    return "var " + k + ' = __s["' + k + '"]';
                  }
                  return "var " + k + ' = __s["' + k + '"] && typeof __s["' + k + '"] === "function" && __s["' + k + '"]._isSignal ? __s["' + k + '"]() : __s["' + k + '"]';
                }).join(";");
                var fn3 = __stxCompile(["__s", "$event"], unwrapVars + ";" + value);
                fn3(eventCapturedScope, handlerEvent);
              } else {
                var fn = __stxCompileScoped(eventCapturedScope, ["$event"], value);
                fn(...__stxArgs(fn, eventCapturedScope), handlerEvent);
              }
            } catch (e) {
              console.warn("[STX] Handler error:", value, e);
            }
          }, { capture: modifiers.includes("capture"), passive: modifiers.includes("passive") || /^(touchstart|touchmove|wheel|mousewheel)$/i.test(eventName) && !modifiers.includes("prevent") && !modifiers.includes("nonpassive"), once: modifiers.includes("once") });
          el.removeAttribute(name);
        }
      });
      if (!skipChildren && el.tagName !== "SCRIPT" && el.tagName !== "STYLE") {
        var children = Array.from(el.childNodes);
        children.forEach(function(child) {
          if (child.nodeType !== Node.ELEMENT_NODE) {
            processElement(child, scope);
            return;
          }
          if (child.tagName === "SCRIPT")
            return;
          if (child.__stx_scope)
            return;
          if (child.hasAttribute && child.hasAttribute("data-stx-scope"))
            return;
          processElement(child, scope);
        });
      }
    }
    function bindSuspense(el, scope) {
      if (el.__stx_suspense_bound)
        return;
      el.__stx_suspense_bound = true;
      var fallbackEl = el.querySelector("[data-stx-suspense-fallback]");
      var errorEl = el.querySelector("[data-stx-suspense-error]");
      var contentEl = el.querySelector("[data-stx-suspense-content]") || el;
      var claimed = suspenseRegistry().filter(function(entry) {
        return entry.el && el.contains(entry.el) && entry.el.closest("[data-stx-suspense]") === el;
      });
      var anyLoading = derived(function() {
        for (var i = 0;i < claimed.length; i++) {
          if (claimed[i].loading && claimed[i].loading())
            return true;
        }
        return false;
      });
      var firstError = derived(function() {
        for (var i = 0;i < claimed.length; i++) {
          var err = claimed[i].error ? claimed[i].error() : null;
          if (err)
            return err;
        }
        return null;
      });
      function setHidden(node, hidden) {
        if (!node || node === el)
          return;
        if (hidden)
          node.setAttribute("hidden", "");
        else
          node.removeAttribute("hidden");
      }
      effect(function() {
        var err = firstError();
        var loading = anyLoading();
        if (err && errorEl) {
          setHidden(errorEl, false);
          setHidden(fallbackEl, true);
          setHidden(contentEl, true);
        } else if (loading) {
          setHidden(fallbackEl, false);
          setHidden(contentEl, true);
          setHidden(errorEl, true);
        } else {
          setHidden(contentEl, false);
          setHidden(fallbackEl, true);
          setHidden(errorEl, true);
        }
      });
      var contentRoot = contentEl === el ? el : contentEl;
      Array.from(contentRoot.childNodes).forEach(function(child) {
        processElement(child, scope);
      });
    }
    function bindShow(el, expr, passedScope = componentScope, attrName = "@show") {
      if (el.__stx_show_bound)
        return;
      el.__stx_show_bound = true;
      const capturedScope = { ...globalHelpers, ...passedScope, ...findElementScope(el) || {} };
      const directSignal = capturedScope[expr];
      if (directSignal && directSignal._isSignal) {
        effect(() => {
          const value = directSignal();
          stxHost.setVisible(el, !!value);
        });
      } else {
        effect(() => {
          var value;
          try {
            var unwrapScope = createExpressionAutoUnwrapProxy(capturedScope, expr);
            var fn = __stxCompileScoped(capturedScope, [], "return " + expr);
            value = fn(...__stxArgs(fn, unwrapScope));
          } catch (e1) {
            try {
              var fn2 = __stxCompileScoped(capturedScope, [], "return " + expr);
              value = fn2(...__stxArgs(fn2, capturedScope));
            } catch (e2) {
              if (!(e2 instanceof ReferenceError) && !(e2 instanceof TypeError))
                console.warn("[STX] Show expression error:", expr, e2);
              stxHost.setVisible(el, false);
              return;
            }
          }
          var wasVisible = stxHost.setVisible(el, !!value);
          if (value && !wasVisible) {
            el.__stx_shown_at = performance.now();
          }
        });
      }
      el.removeAttribute(attrName);
    }
    function bindModel(el, expr, passedScope = componentScope, attrName = "@model") {
      if (el.__stx_model_bound)
        return;
      el.__stx_model_bound = true;
      const tag = el.tagName.toLowerCase();
      const type = el.type;
      const modifiers = attrName.split(".").slice(1);
      const capturedScope = { ...globalHelpers, ...passedScope, ...findElementScope(el) || {} };
      const coerceValue = (value) => {
        var next = value;
        if (modifiers.includes("trim") && typeof next === "string")
          next = next.trim();
        if (modifiers.includes("number") && next !== "") {
          var numeric = Number(next);
          if (!Number.isNaN(numeric))
            next = numeric;
        }
        return next;
      };
      const getValue = () => {
        var direct = capturedScope[expr];
        if (direct && typeof direct === "function" && (direct._isSignal || direct._isDerived))
          return direct();
        try {
          var unwrapScope = createExpressionAutoUnwrapProxy(capturedScope, expr);
          var fn = __stxCompileScoped(unwrapScope, [], "return (" + expr + ")");
          return fn(...__stxArgs(fn, unwrapScope));
        } catch (e) {
          if (!(e instanceof ReferenceError) && !(e instanceof TypeError))
            console.warn("[STX] " + attrName + " get error:", expr, e);
          return "";
        }
      };
      const setValue = (val) => {
        try {
          if (capturedScope[expr] && capturedScope[expr]._isSignal) {
            capturedScope[expr].set(val);
          } else {
            var writeScope = createModelWriteProxy(capturedScope);
            var writeFn = __stxCompile(["__scope__", "__v__"], "with(__scope__) { " + expr + " = __v__ }");
            writeFn(writeScope, val);
          }
        } catch (e) {
          if (!(e instanceof ReferenceError) && !(e instanceof TypeError))
            console.warn("[STX] " + attrName + " set error:", expr, e);
        }
      };
      if (tag === "input" && type === "checkbox") {
        var syncCheckbox = () => {
          var current = getValue();
          el.checked = Array.isArray(current) ? current.some(function(item) {
            return String(item) === String(el.value);
          }) : Boolean(current);
        };
        el.__stx_model_sync = syncCheckbox;
        effect(syncCheckbox);
        stxHost.listen(el, "change", () => {
          var current = getValue();
          if (!Array.isArray(current)) {
            setValue(el.checked);
            return;
          }
          var checkboxValue = coerceValue(el.value);
          var next = current.filter(function(item) {
            return String(item) !== String(checkboxValue);
          });
          if (el.checked)
            next.push(checkboxValue);
          setValue(next);
        });
      } else if (tag === "input" && type === "radio") {
        var syncRadio = () => {
          el.checked = String(getValue()) === String(el.value);
        };
        el.__stx_model_sync = syncRadio;
        effect(syncRadio);
        stxHost.listen(el, "change", () => {
          if (el.checked)
            setValue(coerceValue(el.value));
        });
      } else if (tag === "select") {
        var syncSelect = () => {
          var next = getValue() ?? "";
          if (el.value !== next)
            el.value = next;
        };
        el.__stx_model_sync = syncSelect;
        effect(syncSelect);
        if (!el.__stx_model_observer && typeof window.MutationObserver !== "undefined") {
          el.__stx_model_observer = new window.MutationObserver(syncSelect);
          el.__stx_model_observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["value"] });
          el.__stx_destroy = el.__stx_destroy || [];
          el.__stx_destroy.push(function() {
            if (el.__stx_model_observer)
              el.__stx_model_observer.disconnect();
            el.__stx_model_observer = null;
          });
        }
        stxHost.listen(el, "change", () => setValue(coerceValue(el.value)));
      } else {
        effect(() => {
          var next = getValue() ?? "";
          if (el.value === next)
            return;
          var active = typeof document !== "undefined" && document.activeElement === el;
          var start = null;
          var end = null;
          if (active) {
            try {
              start = el.selectionStart;
              end = el.selectionEnd;
            } catch (e) {
              start = null;
              end = null;
            }
          }
          el.value = next;
          if (active && start !== null && typeof el.setSelectionRange === "function") {
            try {
              el.setSelectionRange(Math.min(start, next.length), Math.min(end == null ? start : end, next.length));
            } catch (e) {}
          }
        });
        stxHost.listen(el, modifiers.includes("lazy") ? "change" : "input", () => setValue(coerceValue(el.value)));
      }
      el.removeAttribute(attrName);
    }
    function bindClass(el, expr, passedScope = componentScope, isVisible) {
      const originalClasses = el.className;
      const capturedScope = { ...globalHelpers, ...passedScope, ...findElementScope(el) || {} };
      const keys = Object.keys(capturedScope);
      const mentioned = new Set(__stxNamesIn(expr));
      const safeKeys = keys.filter((k) => mentioned.has(k) && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k));
      let fn;
      try {
        fn = __stxCompile(safeKeys, "return " + expr);
      } catch (e) {
        console.warn("[STX] bindClass compile error:", expr, e);
        return;
      }
      effect(() => {
        if (isVisible && !isVisible())
          return;
        for (let i = 0;i < safeKeys.length; i++) {
          const v = capturedScope[safeKeys[i]];
          if (v && typeof v === "function" && (v._isSignal || v._isDerived)) {
            v();
          }
        }
        let value;
        try {
          const unwrapScope = createExpressionAutoUnwrapProxy(capturedScope, expr);
          value = fn.apply(null, safeKeys.map((k) => unwrapScope[k]));
        } catch (e1) {
          try {
            value = fn.apply(null, safeKeys.map((k) => capturedScope[k]));
          } catch (e2) {
            if (!(e2 instanceof ReferenceError) && !(e2 instanceof TypeError))
              console.warn("[STX] Class expression error:", expr, e2);
            value = "";
          }
        }
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          Object.keys(value).forEach((cls) => {
            const tokens = cls.split(/\s+/).filter(Boolean);
            if (value[cls])
              tokens.forEach((t) => el.classList.add(t));
            else
              tokens.forEach((t) => el.classList.remove(t));
          });
        } else if (Array.isArray(value)) {
          var _clsArr = [originalClasses, value.filter(Boolean).join(" ")].filter(Boolean).join(" ");
          if (typeof el.className === "string")
            el.className = _clsArr;
          else
            el.setAttribute("class", _clsArr);
        } else {
          var _clsStr = [originalClasses, value || ""].filter(Boolean).join(" ");
          if (typeof el.className === "string")
            el.className = _clsStr;
          else
            el.setAttribute("class", _clsStr);
        }
      });
    }
    function bindStyle(el, expr, passedScope = componentScope, isVisible) {
      const capturedScope = { ...globalHelpers, ...passedScope, ...findElementScope(el) || {} };
      const evalExpr = () => {
        try {
          const unwrapScope = createExpressionAutoUnwrapProxy(capturedScope, expr);
          const fn = __stxCompileScoped(capturedScope, [], "return " + expr);
          return fn(...__stxArgs(fn, unwrapScope));
        } catch (e1) {
          try {
            const fn2 = __stxCompileScoped(capturedScope, [], "return " + expr);
            return fn2(...__stxArgs(fn2, capturedScope));
          } catch (e2) {
            if (!(e2 instanceof ReferenceError) && !(e2 instanceof TypeError))
              console.warn("[STX] Style expression error:", expr, e2);
            return {};
          }
        }
      };
      effect(() => {
        if (isVisible && !isVisible())
          return;
        const value = evalExpr();
        stxHost.setStyle(el, value);
      });
    }
    function tgDurationMs(el) {
      try {
        var cs = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
        if (cs) {
          var raw = (cs.transitionDuration || "").split(",")[0].trim();
          var ms = raw.indexOf("ms") >= 0 ? parseFloat(raw) : parseFloat(raw) * 1000;
          if (ms > 0)
            return ms;
        }
      } catch (e) {}
      return 300;
    }
    function tgOnEnd(el, cb) {
      var done = false;
      function finish() {
        if (done)
          return;
        done = true;
        try {
          el.removeEventListener("transitionend", finish);
        } catch (e) {}
        cb();
      }
      try {
        el.addEventListener("transitionend", finish);
      } catch (e) {}
      setTimeout(finish, tgDurationMs(el) + 60);
    }
    function tgRaf2(fn) {
      var raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : function(f) {
        return setTimeout(f, 16);
      };
      raf(function() {
        raf(fn);
      });
    }
    function tgEnter(el, name) {
      if (!el || el.nodeType !== 1 || !el.classList)
        return;
      el.classList.add(name + "-enter-from", name + "-enter-active");
      tgRaf2(function() {
        el.classList.remove(name + "-enter-from");
        el.classList.add(name + "-enter-to");
        tgOnEnd(el, function() {
          el.classList.remove(name + "-enter-active", name + "-enter-to");
        });
      });
    }
    function tgLeave(el, name) {
      if (!el || el.nodeType !== 1 || !el.classList)
        return false;
      el.classList.add(name + "-leave-from", name + "-leave-active");
      tgRaf2(function() {
        el.classList.remove(name + "-leave-from");
        el.classList.add(name + "-leave-to");
        tgOnEnd(el, function() {
          if (el.parentNode)
            el.parentNode.removeChild(el);
        });
      });
      return true;
    }
    function tgSnapshot(els) {
      var m = new Map;
      for (var i = 0;i < els.length; i++) {
        var el = els[i];
        if (el && el.nodeType === 1 && el.getBoundingClientRect) {
          try {
            m.set(el, el.getBoundingClientRect());
          } catch (e) {}
        }
      }
      return m;
    }
    function tgFlip(els, first, name) {
      var moved = [];
      for (var i = 0;i < els.length; i++) {
        var el = els[i];
        if (!el || el.nodeType !== 1 || !first.has(el) || !el.getBoundingClientRect)
          continue;
        var last, f = first.get(el);
        try {
          last = el.getBoundingClientRect();
        } catch (e) {
          continue;
        }
        var dx = f.left - last.left, dy = f.top - last.top;
        if (dx || dy) {
          el.style.transform = "translate(" + dx + "px," + dy + "px)";
          el.style.transitionDuration = "0s";
          moved.push(el);
        }
      }
      if (!moved.length)
        return;
      if (els[0] && typeof els[0].offsetHeight === "number")
        els[0].offsetHeight;
      var raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : function(f) {
        return setTimeout(f, 16);
      };
      raf(function() {
        moved.forEach(function(el) {
          el.classList.add(name + "-move");
          el.style.transform = "";
          el.style.transitionDuration = "";
          tgOnEnd(el, function() {
            el.classList.remove(name + "-move");
            el.style.transform = "";
            el.style.transitionDuration = "";
          });
        });
      });
    }
    var __forComponentScopeCounter = 0;
    var __forComponentSetupFactories = new Map;
    function forEachGroupElement(nodes, callback) {
      function visit(node, insideTemplateContent) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE)
          return;
        callback(node, insideTemplateContent);
        var entersTemplateContent = node.tagName === "TEMPLATE" && node.content;
        var childRoot = entersTemplateContent ? node.content : node;
        Array.from(childRoot.childNodes || []).forEach(function(child) {
          visit(child, insideTemplateContent || entersTemplateContent);
        });
      }
      nodes.forEach(function(node) {
        visit(node, false);
      });
    }
    function remapForComponentScopes(nodes) {
      var scopeMap = {};
      forEachGroupElement(nodes, function(node) {
        if (!node.hasAttribute || !node.hasAttribute("data-stx-scope"))
          return;
        var oldId = node.getAttribute("data-stx-scope");
        if (!oldId)
          return;
        if (!scopeMap[oldId])
          scopeMap[oldId] = oldId + "_for_" + ++__forComponentScopeCounter;
        if (!node.hasAttribute("data-stx-template-scope"))
          node.setAttribute("data-stx-template-scope", oldId);
        node.setAttribute("data-stx-scope", scopeMap[oldId]);
      });
      var oldIds = Object.keys(scopeMap);
      if (!oldIds.length)
        return;
      forEachGroupElement(nodes, function(node) {
        if (node.attributes) {
          Array.from(node.attributes).forEach(function(rawAttribute) {
            var attribute = Array.isArray(rawAttribute) ? { name: rawAttribute[0], value: rawAttribute[1] } : rawAttribute;
            if (!attribute || attribute.name === "data-stx-scope" || attribute.name === "data-stx-template-scope")
              return;
            var value = attribute.value;
            if (typeof value !== "string")
              return;
            oldIds.forEach(function(oldId) {
              if (value.indexOf(oldId) !== -1)
                value = value.split(oldId).join(scopeMap[oldId]);
            });
            if (value !== attribute.value)
              node.setAttribute(attribute.name, value);
          });
        }
      });
    }
    function hydrateComponentScopes(nodes, callerScope) {
      var roots = [];
      var scripts = [];
      forEachGroupElement(nodes, function(node, insideTemplateContent) {
        if (insideTemplateContent)
          return;
        if (node.hasAttribute && node.hasAttribute("data-stx-scope"))
          roots.push(node);
        if (node.tagName === "SCRIPT" && node.hasAttribute("data-stx-scoped"))
          scripts.push(node);
      });
      if (!roots.length)
        return;
      function hasPendingStructuralAncestor(root) {
        var cursor = root && root.parentElement;
        while (cursor && cursor.nodeType === Node.ELEMENT_NODE) {
          if (cursor.hasAttribute("@for") || cursor.hasAttribute(":for") || cursor.hasAttribute("x-for") || cursor.hasAttribute("@if") || cursor.hasAttribute(":if") || cursor.hasAttribute("x-if") || cursor.hasAttribute("@else-if") || cursor.hasAttribute(":else-if") || cursor.hasAttribute("x-else-if") || cursor.hasAttribute("@else") || cursor.hasAttribute(":else") || cursor.hasAttribute("x-else"))
            return true;
          cursor = cursor.parentElement;
        }
        return false;
      }
      scripts.forEach(function(old) {
        var text = old.textContent || "";
        var pendingRoots = roots.filter(function(root) {
          var scopeId = root.getAttribute("data-stx-scope");
          var originalScopeId = root.getAttribute("data-stx-template-scope") || scopeId;
          return scopeId && originalScopeId && text.indexOf(originalScopeId) !== -1 && !hasPendingStructuralAncestor(root) && !(window.stx._scopes && window.stx._scopes[scopeId]);
        });
        if (!pendingRoots.length)
          return;
        var setup = __forComponentSetupFactories.get(text);
        if (!setup) {
          try {
            setup = new Function(text);
            __forComponentSetupFactories.set(text, setup);
          } catch (e) {
            console.error("[stx] cloned component setup compile error:", e);
            return;
          }
        }
        pendingRoots.forEach(function(root) {
          var scopeId = root.getAttribute("data-stx-scope");
          var originalScopeId = root.getAttribute("data-stx-template-scope") || scopeId;
          if (!scopeId || !originalScopeId)
            return;
          root.setAttribute("data-stx-scope", originalScopeId);
          try {
            setup();
            var registeredScope = window.stx._scopes && (window.stx._scopes[originalScopeId] || window.stx._scopes[scopeId]);
            if (registeredScope && originalScopeId !== scopeId) {
              delete window.stx._scopes[originalScopeId];
              window.stx._scopes[scopeId] = registeredScope;
            }
          } catch (e) {
            console.error("[stx] cloned component setup error:", e);
          } finally {
            root.setAttribute("data-stx-scope", scopeId);
          }
        });
        var isStructuralSource = pendingRoots.some(function(root) {
          return root.hasAttribute("@for") || root.hasAttribute(":for") || root.hasAttribute("x-for") || root.hasAttribute("@if") || root.hasAttribute(":if") || root.hasAttribute("x-if");
        });
        if (!isStructuralSource && old.parentNode)
          old.parentNode.removeChild(old);
      });
      roots.forEach(function(root) {
        var scopeId = root.getAttribute("data-stx-scope");
        var scopeVars = scopeId && window.stx._scopes && window.stx._scopes[scopeId];
        var resolvedCallerScope = resolveComponentCallerScope(root, callerScope);
        root.__stx_parent_scope = resolvedCallerScope;
        bindParentComponentProps(root, resolvedCallerScope);
        if (!scopeVars || root.__stx_disposers)
          return;
        scopeVars.__el = root;
        var childScope = { ...resolvedCallerScope, ...scopeVars };
        root.__stx_disposers = trackEffects(function() {
          processElement(root, childScope);
        });
        if (scopeVars.__mountCallbacks && !scopeVars.__mounted) {
          scopeVars.__mounted = true;
          runMountCallbacks(scopeVars.__mountCallbacks, scopeDestroySink(scopeVars));
        }
      });
    }
    function bindFor(el, passedScope = componentScope, attrName = "@for") {
      if (el.__stx_for_bound)
        return;
      el.__stx_for_bound = true;
      const expr = el.getAttribute(attrName);
      const match = expr.match(/^\s*\(?\s*(\w+)(?:\s*,\s*(\w+))?\s*\)?\s+(?:in|of)\s+(.+)\s*$/);
      if (!match) {
        console.warn("[STX] Invalid " + attrName + ":", expr);
        return;
      }
      const [, itemName, indexName, listExpr] = match;
      const parent = el.parentNode;
      if (!parent) {
        console.warn("[STX] bindFor: element has no parent, skipping");
        return;
      }
      const placeholder = stxHost.anchor("stx-for");
      const isTemplate = el.tagName === "TEMPLATE";
      const componentSetupTemplates = [];
      if (!isTemplate && el.hasAttribute("data-stx-scope")) {
        const componentScopeId = el.getAttribute("data-stx-scope");
        const componentTemplateScopeId = el.getAttribute("data-stx-template-scope") || componentScopeId;
        let setupSibling = el.nextSibling;
        while (setupSibling) {
          const nextSetupSibling = setupSibling.nextSibling;
          if (setupSibling.nodeType === Node.TEXT_NODE && !(setupSibling.textContent || "").trim()) {
            setupSibling = nextSetupSibling;
            continue;
          }
          if (setupSibling.nodeType === Node.COMMENT_NODE) {
            setupSibling = nextSetupSibling;
            continue;
          }
          if (setupSibling.nodeType === Node.ELEMENT_NODE && setupSibling.tagName === "SCRIPT" && setupSibling.hasAttribute("data-stx-scoped") && ((setupSibling.textContent || "").indexOf(componentScopeId) !== -1 || componentTemplateScopeId && (setupSibling.textContent || "").indexOf(componentTemplateScopeId) !== -1)) {
            componentSetupTemplates.push(stxHost.clone(setupSibling));
            stxHost.remove(setupSibling);
            setupSibling = nextSetupSibling;
            continue;
          }
          break;
        }
      }
      const ifExpr = el.getAttribute("@if") || el.getAttribute(":if");
      const loadingExpr = el.getAttribute("@loading");
      const emptyExpr = el.getAttribute("@empty");
      let loadingTemplate = null;
      let emptyTemplate = null;
      let sibling = el.nextElementSibling;
      while (sibling) {
        if (sibling.hasAttribute("@for-loading")) {
          loadingTemplate = stxHost.clone(sibling);
          loadingTemplate.removeAttribute("@for-loading");
          stxHost.remove(sibling);
          sibling = el.nextElementSibling;
          continue;
        }
        if (sibling.hasAttribute("@for-empty")) {
          emptyTemplate = stxHost.clone(sibling);
          emptyTemplate.removeAttribute("@for-empty");
          stxHost.remove(sibling);
          sibling = el.nextElementSibling;
          continue;
        }
        break;
      }
      const capturedScope = findElementScope(el) || findElementScope(parent);
      stxHost.insert(parent, placeholder, el);
      disposeSubtreeScopes(el);
      stxHost.remove(el);
      const keyExpr = el.getAttribute(":key") || el.getAttribute("x-bind:key");
      let templateContent;
      if (isTemplate) {
        templateContent = el.content;
        deferRowConditionals(templateContent);
      } else {
        deferRowConditionals(el);
        const wrapper = stxHost.clone(el);
        wrapper.removeAttribute("@for");
        wrapper.removeAttribute(":for");
        wrapper.removeAttribute("x-for");
        wrapper.removeAttribute("@loading");
        wrapper.removeAttribute("@empty");
        wrapper.removeAttribute(":key");
        wrapper.removeAttribute("x-bind:key");
        if (ifExpr) {
          wrapper.removeAttribute("@if");
          wrapper.removeAttribute(":if");
          wrapper.removeAttribute("x-if");
        }
        templateContent = wrapper;
      }
      let currentElements = [];
      let currentGroups = [];
      let currentKeys = [];
      let loadingElement = null;
      let emptyElement = null;
      const liveGroupNodes = (group) => {
        if (!isTemplate || !group || group.length < 2)
          return group || [];
        const start = group[0];
        const end = group[group.length - 1];
        if (!start || !end || start.parentNode !== parent || end.parentNode !== parent)
          return group.filter((groupNode) => groupNode && groupNode.parentNode === parent);
        const nodes = [];
        let currentNode = start;
        while (currentNode) {
          nodes.push(currentNode);
          if (currentNode === end)
            break;
          currentNode = currentNode.nextSibling;
        }
        return nodes;
      };
      const removeGroup = (group) => {
        const liveNodes = liveGroupNodes(group);
        const liveSet = new Set(liveNodes);
        liveNodes.forEach((e) => {
          disposeSubtreeEffects(e);
          disposeSubtreeScopes(e);
          stxHost.remove(e);
        });
        group.forEach((groupNode) => {
          if (liveSet.has(groupNode))
            return;
          disposeSubtreeEffects(groupNode);
          disposeSubtreeScopes(groupNode);
          stxHost.remove(groupNode);
        });
      };
      const clearRenderedItems = () => {
        currentGroups.forEach(removeGroup);
        currentElements = [];
        currentGroups = [];
        currentKeys = [];
      };
      const evalExpr = (expression, extraScope = {}) => {
        try {
          if (/^__[A-Z_]+__$/.test(expression.trim())) {
            return expression;
          }
          const scope = { ...globalHelpers, ...passedScope, ...capturedScope || {}, ...extraScope };
          const unwrapScope = createAutoUnwrapProxy(scope, function(prop) {
            if (typeof prop !== "string")
              return false;
            return expressionCallsSignal(expression, prop) || expressionUsesSignalApi(expression, prop);
          });
          const fn = __stxCompileScoped(scope, [], "return " + expression);
          return fn(...__stxArgs(fn, unwrapScope));
        } catch (e) {
          if (!(e instanceof ReferenceError) && !(e instanceof TypeError))
            console.warn("[STX] Expression error:", expression, e);
          return "";
        }
      };
      const evalLazy = (expression, extraScope = {}) => {
        try {
          if (/^__[A-Z_]+__$/.test(expression.trim()))
            return expression;
          const scope = { ...globalHelpers, ...passedScope, ...capturedScope || {}, ...extraScope };
          const unwrapScope = createAutoUnwrapProxy(scope, function(prop) {
            if (typeof prop !== "string")
              return false;
            return expressionCallsSignal(expression, prop) || expressionUsesSignalApi(expression, prop);
          });
          const fn = __stxCompileScoped(unwrapScope, [], "return " + expression + "");
          return fn(...__stxArgs(fn, unwrapScope));
        } catch (e) {
          if (!(e instanceof ReferenceError) && !(e instanceof TypeError))
            console.warn("[STX] Expression error:", expression, e);
          return "";
        }
      };
      const showLoading = () => {
        hideLoading();
        hideEmpty();
        if (loadingTemplate) {
          loadingElement = stxHost.clone(loadingTemplate);
          stxHost.insert(parent, loadingElement, placeholder);
        }
      };
      const hideLoading = () => {
        if (loadingElement) {
          stxHost.remove(loadingElement);
          loadingElement = null;
        }
      };
      const showEmpty = () => {
        hideLoading();
        hideEmpty();
        if (emptyTemplate) {
          emptyElement = stxHost.clone(emptyTemplate);
          stxHost.insert(parent, emptyElement, placeholder);
          const shownEmpty = emptyElement;
          shownEmpty.__stx_effect_disposers = trackEffects(function() {
            processElement(shownEmpty);
          });
        }
      };
      const hideEmpty = () => {
        if (emptyElement) {
          if (emptyElement.nodeType === 1)
            disposeSubtreeEffects(emptyElement);
          stxHost.remove(emptyElement);
          emptyElement = null;
        }
      };
      const createItemElements = (item, index, key) => {
        const itemSignal = state(item);
        itemSignal._isStxLoopItem = true;
        const indexSignal = state(index);
        const itemScope = { ...globalHelpers, ...passedScope, ...capturedScope || {} };
        itemScope[itemName] = itemSignal;
        if (indexName)
          itemScope[indexName] = indexSignal;
        const elements = [];
        if (isTemplate) {
          elements.push(stxHost.anchor("stx-for-item-start"));
          Array.from(templateContent.childNodes).forEach((node) => {
            const clone = stxHost.clone(node);
            if (clone.nodeType === 1) {
              clone.__stx_for_scope = itemScope;
            }
            elements.push(clone);
          });
          elements.push(stxHost.anchor("stx-for-item-end"));
        } else {
          const clone = stxHost.clone(templateContent);
          clone.__stx_for_scope = itemScope;
          elements.push(clone);
          componentSetupTemplates.forEach(function(setupTemplate) {
            elements.push(stxHost.clone(setupTemplate));
          });
        }
        remapForComponentScopes(elements);
        elements.__stx_signals = { item: itemSignal, index: indexSignal };
        return elements;
      };
      const getItemKey = (item, index) => {
        if (!keyExpr)
          return String(index);
        try {
          const scope = { [itemName]: item };
          if (indexName)
            scope[indexName] = index;
          const fn = __stxCompile([itemName, indexName || "_idx"], "return " + keyExpr);
          return String(fn(item, index));
        } catch (e) {
          return String(index);
        }
      };
      effect(() => {
        if (loadingExpr) {
          const isLoading = evalLazy(loadingExpr);
          if (isLoading) {
            clearRenderedItems();
            showLoading();
            return;
          }
        }
        hideLoading();
        let list = evalLazy(listExpr);
        var trailingParens = /\(\s*\)\s*$/;
        if (!Array.isArray(list) && trailingParens.test(listExpr)) {
          list = evalLazy(listExpr.replace(trailingParens, ""));
        }
        if (!Array.isArray(list) && typeof list === "function" && (list._isSignal || list._isDerived)) {
          try {
            list = list();
          } catch {}
        }
        if (ifExpr) {
          const ifValue = evalLazy(ifExpr);
          if (!ifValue) {
            clearRenderedItems();
            hideEmpty();
            return;
          }
        }
        if (!Array.isArray(list)) {
          var diagScope;
          var rootName = "?";
          var rootInScope = true;
          var rootVal;
          try {
            var diagMerged = { ...globalHelpers, ...passedScope, ...capturedScope || {} };
            var firstIdent = listExpr.match(/^[A-Za-z_$][\w$]*/);
            rootName = firstIdent ? firstIdent[0] : "?";
            rootInScope = Object.prototype.hasOwnProperty.call(diagMerged, rootName);
            rootVal = rootInScope ? diagMerged[rootName] : "<NOT-IN-SCOPE>";
            var rootKeys = rootVal && typeof rootVal === "object" ? Object.keys(rootVal).slice(0, 8).join(",") : "-";
            diagScope = "[root=" + rootName + " inScope=" + rootInScope + " type=" + typeof rootVal + " isStxStore=" + !!(rootVal && rootVal._isStxStore) + " keys=" + rootKeys + "]";
          } catch (_e) {
            diagScope = "[diag-error]";
            rootInScope = true;
          }
          var advice;
          if (!rootInScope) {
            advice = "Nothing named " + rootName + " is in the client scope. A script-server declaration is not available here: :for is expanded on the client. " + "Either wrap it in state() inside a script-client block, or iterate it with the server-side @foreach(" + rootName + " as item).";
          } else if (typeof rootVal === "function" && (rootVal._isSignal || rootVal._isDerived)) {
            advice = rootName + " is a signal, so try the bare reference: " + rootName + " instead of " + rootName + "().";
          } else {
            advice = rootName + " resolved to a " + typeof rootVal + ", not an array.";
          }
          console.warn("[STX] :for expected an array; got " + (list === "" ? "empty/error" : typeof list) + ' for expression "' + listExpr + '". ' + diagScope + " " + advice);
          return;
        }
        if (list.length === 0) {
          clearRenderedItems();
          if (emptyExpr) {
            const emptyContent = evalLazy(emptyExpr);
            hideEmpty();
            if (emptyContent && typeof emptyContent === "string") {
              emptyElement = document.createTextNode(emptyContent);
              stxHost.insert(parent, emptyElement, placeholder);
            }
          } else if (emptyTemplate) {
            showEmpty();
          }
          return;
        }
        hideEmpty();
        var tgIsGroup = !!(parent && parent.hasAttribute && parent.hasAttribute("data-stx-transition-group"));
        var tgName = tgIsGroup ? parent.getAttribute("data-stx-transition-group") || "v" : null;
        var tgReady = tgIsGroup && !!parent.__stx_tg_init;
        var tgFirst = tgReady ? tgSnapshot(currentElements) : null;
        const newKeys = list.map((item, i) => getItemKey(item, i));
        const oldKeyMap = new Map;
        for (let i = 0;i < currentKeys.length; i++) {
          const k = currentKeys[i];
          if (!oldKeyMap.has(k))
            oldKeyMap.set(k, []);
          oldKeyMap.get(k).push(currentGroups[i] || []);
        }
        const newElements = [];
        const newGroups = [];
        const seenKeys = new Set;
        let warnedDuplicateKey = false;
        let cursor = null;
        for (let ci = 0;ci < currentGroups.length && !cursor; ci++) {
          const seed = liveGroupNodes(currentGroups[ci] || []);
          if (seed.length)
            cursor = seed[0];
        }
        for (let i = 0;i < list.length; i++) {
          const key = newKeys[i];
          const existing = oldKeyMap.get(key);
          if (seenKeys.has(key) && !warnedDuplicateKey) {
            warnedDuplicateKey = true;
            console.warn("[STX] :for has more than one item with the key " + key + ". Rows are matched in order, so give each item a key of its own.");
          }
          seenKeys.add(key);
          if (existing && existing.length > 0) {
            const group = existing.shift();
            const liveNodes = liveGroupNodes(group);
            for (let li = 0;li < liveNodes.length; li++) {
              const groupNode = liveNodes[li];
              if (groupNode === cursor) {
                cursor = cursor.nextSibling;
              } else {
                stxHost.insert(parent, groupNode, cursor || placeholder);
              }
            }
            newElements.push(...group);
            newGroups.push(group);
            const signals = group.__stx_signals;
            if (signals) {
              signals.item.set(list[i]);
              signals.index.set(i);
            }
          } else {
            const elements = createItemElements(list[i], i, key);
            elements.forEach((el) => {
              stxHost.insert(parent, el, cursor || placeholder);
              if (tgReady && el.isConnected)
                tgEnter(el, tgName);
            });
            hydrateComponentScopes(elements, elements.find(function(node) {
              return node && node.__stx_for_scope;
            })?.__stx_for_scope || passedScope);
            elements.forEach((el) => {
              if (el.nodeType === 1) {
                var itemScope = el.__stx_for_scope || passedScope;
                delete el.__stx_for_scope;
                if (!el.__stx_disposers && el.tagName !== "SCRIPT")
                  el.__stx_effect_disposers = trackEffects(function() {
                    processElement(el, itemScope);
                  });
                el.removeAttribute("x-cloak");
                el.querySelectorAll("[x-cloak]").forEach((c) => c.removeAttribute("x-cloak"));
              }
            });
            newElements.push(...elements);
            newGroups.push(elements);
          }
        }
        for (const groups of oldKeyMap.values()) {
          if (groups.length > 0) {
            groups.forEach((group) => {
              if (tgReady) {
                const liveNodes = liveGroupNodes(group);
                const transitioned = new Set;
                liveNodes.forEach((el) => {
                  disposeSubtreeEffects(el);
                  disposeSubtreeScopes(el);
                  if (tgLeave(el, tgName))
                    transitioned.add(el);
                  else
                    stxHost.remove(el);
                });
                group.forEach((el) => {
                  if (transitioned.has(el) || liveNodes.includes(el))
                    return;
                  disposeSubtreeEffects(el);
                  disposeSubtreeScopes(el);
                  stxHost.remove(el);
                });
              } else {
                removeGroup(group);
              }
            });
          }
        }
        currentElements = newElements;
        currentGroups = newGroups;
        currentKeys = newKeys;
        if (tgReady && tgFirst)
          tgFlip(newElements, tgFirst, tgName);
        if (tgIsGroup)
          parent.__stx_tg_init = true;
      });
    }
    var IF_ATTRS = [":if", "x-if", "@if"];
    var FOR_ATTRS = [":for", "x-for", "@for"];
    function deferRowConditionals(root) {
      if (!root || !root.querySelectorAll || typeof document === "undefined" || !document.createElement)
        return;
      if (!document.createElement("template").content)
        return;
      var candidates = Array.prototype.slice.call(root.querySelectorAll("*"));
      for (var i = 0;i < candidates.length; i++) {
        var el = candidates[i];
        if (el.tagName === "TEMPLATE" || !el.parentNode)
          continue;
        var attr = null;
        for (var a = 0;a < IF_ATTRS.length; a++) {
          if (el.hasAttribute(IF_ATTRS[a])) {
            attr = IF_ATTRS[a];
            break;
          }
        }
        if (!attr)
          continue;
        var skip = false;
        for (var f = 0;f < FOR_ATTRS.length; f++) {
          if (el.hasAttribute(FOR_ATTRS[f]))
            skip = true;
        }
        if (skip || getElseAttrInfo(el))
          continue;
        var next = el.nextElementSibling;
        if (next && (getElseAttrInfo(next) || next.tagName === "SCRIPT"))
          continue;
        if (el.hasAttribute("data-stx-scope") || el.hasAttribute("x-data") || el.querySelector("script"))
          continue;
        var holder = document.createElement("template");
        holder.setAttribute(attr, el.getAttribute(attr));
        el.removeAttribute(attr);
        el.parentNode.insertBefore(holder, el);
        holder.content.appendChild(el);
      }
    }
    var __bindIfCounter = 0;
    function getElseAttrInfo(el) {
      if (!el || !el.hasAttribute)
        return null;
      if (el.hasAttribute(":else-if"))
        return { name: ":else-if", terminal: false };
      if (el.hasAttribute("x-else-if"))
        return { name: "x-else-if", terminal: false };
      if (el.hasAttribute("@else-if"))
        return { name: "@else-if", terminal: false };
      if (el.hasAttribute(":else"))
        return { name: ":else", terminal: true };
      if (el.hasAttribute("x-else"))
        return { name: "x-else", terminal: true };
      if (el.hasAttribute("@else"))
        return { name: "@else", terminal: true };
      return null;
    }
    function findIfChain(el, ifAttr) {
      var chain = [{ el, attr: ifAttr, expr: el.getAttribute(ifAttr), terminal: false }];
      var sib = el.nextElementSibling;
      while (sib) {
        var info = getElseAttrInfo(sib);
        if (!info)
          break;
        chain.push({ el: sib, attr: info.name, expr: info.terminal ? null : sib.getAttribute(info.name), terminal: info.terminal });
        if (info.terminal)
          break;
        sib = sib.nextElementSibling;
      }
      return chain;
    }
    function bindIfChain(chain, passedScope = componentScope) {
      var head = chain[0].el;
      if (head.__stx_if_bound) {
        return;
      }
      var parent = head.parentNode;
      if (!parent) {
        console.warn("[STX] bindIfChain: head element has no parent, skipping");
        return;
      }
      var capturedComponentScope = { ...passedScope };
      chain.forEach(function(b) {
        preserveConditionalComponentScopes(b.el, capturedComponentScope);
        b.el.__stx_if_bound = true;
        b.el.__stx_chain_member = true;
        b.el.__stx_chain_active = false;
        b.el.__stx_if_visible = state(false);
        b.capturedElementScope = findElementScope(b.el);
        b.placeholder = stxHost.anchor("stx-if-chain");
        stxHost.insert(parent, b.placeholder, b.el);
        b.el.removeAttribute(b.attr);
        b.isTemplate = b.el.tagName === "TEMPLATE";
        b.pristine = b.isTemplate ? stxHost.clone(b.el.content) : null;
        b.nodes = b.isTemplate ? [] : [b.el];
        b.endMarker = null;
        stxHost.remove(b.el);
        b.childrenProcessed = false;
      });
      function evalBranch(b) {
        var expression = b.expr;
        if (/^__[A-Z_]+__$/.test(expression.trim()))
          return expression;
        var scope = { ...globalHelpers, ...capturedComponentScope, ...b.capturedElementScope || {} };
        try {
          var unwrapScope = createExpressionAutoUnwrapProxy(scope, expression);
          var fn = __stxCompileScoped(unwrapScope, [], "return " + expression + "");
          return fn(...__stxArgs(fn, unwrapScope));
        } catch (e1) {
          try {
            var fn2 = __stxCompileScoped(scope, [], "return " + expression + "");
            return fn2(...__stxArgs(fn2, scope));
          } catch (e2) {
            if (!(e2 instanceof ReferenceError) && !(e2 instanceof TypeError))
              console.warn("[STX] Expression error:", expression, e2);
            return "";
          }
        }
      }
      var currentIdx = -1;
      effect(function() {
        var pickedIdx = -1;
        for (var i = 0;i < chain.length; i++) {
          var b = chain[i];
          var matched = b.terminal ? true : !!evalBranch(b);
          if (matched && pickedIdx === -1)
            pickedIdx = i;
        }
        if (__stxDevtoolsTracking) {
          var __ifScope = null;
          try {
            __ifScope = stxHost.scopeOf(head);
          } catch (e) {
            __ifScope = null;
          }
          __stxDevtoolsRecordIf({ scopeId: __ifScope ? __ifScope.getAttribute("data-stx-scope") : null, branches: chain.map(function(c) {
            return c.attr;
          }), picked: pickedIdx, pickedAttr: pickedIdx >= 0 ? chain[pickedIdx].attr : null, prev: currentIdx });
        }
        if (pickedIdx === currentIdx)
          return;
        if (currentIdx !== -1) {
          var gone = chain[currentIdx];
          gone.el.__stx_chain_active = false;
          gone.el.__stx_if_visible.set(false);
          if (gone.isTemplate) {
            if (gone.endMarker && gone.endMarker.parentNode) {
              var doomed = gone.placeholder.nextSibling;
              while (doomed && doomed !== gone.endMarker) {
                var nextDoomed = doomed.nextSibling;
                disposeSubtreeEffects(doomed);
                stxHost.remove(doomed);
                doomed = nextDoomed;
              }
              stxHost.remove(gone.endMarker);
              gone.endMarker = null;
            }
            gone.nodes.forEach(function(n) {
              if (!n.parentNode)
                return;
              disposeSubtreeEffects(n);
              stxHost.remove(n);
            });
            if (typeof gone.el.__stx_chain_disposers === "function") {
              try {
                gone.el.__stx_chain_disposers();
              } catch (e) {}
              gone.el.__stx_chain_disposers = null;
            }
            gone.nodes = [];
            gone.childrenProcessed = false;
          } else {
            gone.nodes.forEach(function(n) {
              if (!n.parentNode)
                return;
              var parentEl = n.parentNode;
              if (!parentEl.__stx_detached_if)
                parentEl.__stx_detached_if = new Set;
              parentEl.__stx_detached_if.add(n);
              stxHost.remove(n);
            });
          }
        }
        if (pickedIdx !== -1) {
          var pick = chain[pickedIdx];
          pick.el.__stx_chain_active = true;
          var anchor = pick.placeholder.nextSibling;
          var pickHost = pick.placeholder.parentNode;
          if (pick.isTemplate && pick.nodes.length === 0)
            pick.nodes = Array.prototype.slice.call(stxHost.clone(pick.pristine).childNodes);
          pick.nodes.forEach(function(n) {
            if (pickHost.__stx_detached_if)
              pickHost.__stx_detached_if.delete(n);
            stxHost.insert(pickHost, n, anchor);
          });
          pick.el.__stx_if_visible.set(true);
          if (pick.isTemplate) {
            if (!pick.endMarker)
              pick.endMarker = stxHost.anchor("stx-if-chain-end");
            stxHost.insert(pickHost, pick.endMarker, anchor);
          }
          pick.el.__stx_shown_at = performance.now();
          if (!pick.childrenProcessed) {
            pick.childrenProcessed = true;
            pick.el.__stx_chain_disposers = trackEffects(function() {
              peek(function() {
                var childScope = { ...globalHelpers, ...capturedComponentScope, ...pick.capturedElementScope || {} };
                var previouslyTrackedNodes = new Set;
                pick.nodes.forEach(function(n) {
                  if (n && n.__stx_disposers)
                    previouslyTrackedNodes.add(n);
                });
                hydrateComponentScopes(pick.nodes, childScope);
                pick.nodes.forEach(function(n) {
                  if (n.nodeType !== 1)
                    return;
                  if (previouslyTrackedNodes.has(n) || !n.__stx_disposers)
                    processElement(n, childScope);
                  n.removeAttribute("x-cloak");
                  n.querySelectorAll("[x-cloak]").forEach(function(c) {
                    c.removeAttribute("x-cloak");
                  });
                });
                resumeDetachedBranches();
              });
            });
          }
        }
        currentIdx = pickedIdx;
      });
    }
    const detachedBranches = new Set;
    function resumeDetachedBranches() {
      if (!detachedBranches.size)
        return;
      Array.from(detachedBranches).forEach(function(resume) {
        if (!resume.el.isConnected)
          return;
        detachedBranches.delete(resume);
        resume();
      });
    }
    function bindIf(el, passedScope = componentScope, attrName = "@if") {
      if (el.__stx_if_bound) {
        return;
      }
      el.__stx_if_bound = true;
      const expr = el.getAttribute(attrName);
      const parent = el.parentNode;
      if (!parent) {
        console.warn("[STX] bindIf: element has no parent, skipping");
        return;
      }
      const placeholder = stxHost.anchor("stx-if");
      let endMarker = null;
      let isInserted = true;
      const isTemplate = el.tagName === "TEMPLATE";
      if (!isTemplate)
        el.__stx_if_visible = state(true);
      const componentSetupSiblings = isTemplate ? [] : findConditionalComponentSetupSiblings(el);
      let currentNodes = isTemplate ? [] : [el, ...componentSetupSiblings];
      const capturedElementScope = findElementScope(el);
      const capturedComponentScope = { ...passedScope };
      preserveConditionalComponentScopes(el, capturedComponentScope);
      stxHost.insert(parent, placeholder, el);
      el.removeAttribute(attrName);
      if (isTemplate) {
        isInserted = false;
        stxHost.remove(el);
      }
      const evalExpr = (expression) => {
        if (/^__[A-Z_]+__$/.test(expression.trim())) {
          return expression;
        }
        try {
          const scope = { ...globalHelpers, ...capturedComponentScope, ...capturedElementScope || {} };
          const unwrapScope = createExpressionAutoUnwrapProxy(scope, expression);
          const fn = __stxCompileScoped(unwrapScope, [], "return " + expression + "");
          return fn(...__stxArgs(fn, unwrapScope));
        } catch (e1) {
          try {
            const scope2 = { ...globalHelpers, ...capturedComponentScope, ...capturedElementScope || {} };
            const fn2 = __stxCompileScoped(scope2, [], "return " + expression + "");
            return fn2(...__stxArgs(fn2, scope2));
          } catch (e2) {
            if (!(e2 instanceof ReferenceError) && !(e2 instanceof TypeError))
              console.warn("[STX] Expression error:", expression, e2);
            return "";
          }
        }
      };
      let childrenProcessed = false;
      const processChildrenWithScope = () => {
        const childScope = { ...globalHelpers, ...capturedComponentScope, ...capturedElementScope || {} };
        Array.from(el.childNodes).forEach((child) => processElement(child, childScope));
        childrenProcessed = true;
      };
      const processTemplateNodes = (nodes) => {
        const childScope = { ...globalHelpers, ...capturedComponentScope, ...capturedElementScope || {} };
        hydrateComponentScopes(nodes, childScope);
        nodes.forEach((node) => {
          if (!node.__stx_disposers && node.tagName !== "SCRIPT")
            node.__stx_effect_disposers = trackEffects(function() {
              processElement(node, childScope);
            });
          if (node.nodeType === 1) {
            node.removeAttribute("x-cloak");
            node.querySelectorAll("[x-cloak]").forEach((c) => c.removeAttribute("x-cloak"));
          }
        });
        resumeDetachedBranches();
      };
      const fullScope = { ...globalHelpers, ...capturedComponentScope, ...capturedElementScope || {} };
      const directSignal = fullScope[expr];
      effect(() => {
        var value;
        if (directSignal && (directSignal._isSignal || directSignal._isDerived)) {
          value = directSignal();
        } else {
          value = evalExpr(expr);
        }
        if (isTemplate) {
          if (value && !isInserted) {
            currentNodes = Array.from(el.content.childNodes).map((n) => stxHost.clone(n));
            const insertionAnchor = placeholder.nextSibling;
            currentNodes.forEach((node) => stxHost.insert(parent, node, insertionAnchor));
            if (!endMarker)
              endMarker = stxHost.anchor("stx-if-end");
            stxHost.insert(parent, endMarker, insertionAnchor);
            processTemplateNodes(currentNodes);
            childrenProcessed = true;
            currentNodes.forEach(function(n) {
              if (n.nodeType === 1)
                n.__stx_shown_at = performance.now();
            });
            isInserted = true;
          } else if (!value && isInserted) {
            if (endMarker && endMarker.parentNode === parent) {
              var doomed = placeholder.nextSibling;
              while (doomed && doomed !== endMarker) {
                var nextDoomed = doomed.nextSibling;
                disposeSubtreeEffects(doomed);
                stxHost.remove(doomed);
                doomed = nextDoomed;
              }
              stxHost.remove(endMarker);
            }
            currentNodes.forEach((node) => {
              disposeSubtreeEffects(node);
              stxHost.remove(node);
            });
            currentNodes = [];
            isInserted = false;
            childrenProcessed = false;
          } else if (value && isInserted && !childrenProcessed) {
            childrenProcessed = true;
            peek(function() {
              if (isInserted)
                processTemplateNodes(currentNodes);
            });
          }
        } else {
          if (value && !isInserted) {
            const insertionAnchor = placeholder.nextSibling;
            currentNodes.forEach((node) => stxHost.insert(parent, node, insertionAnchor));
            if (parent && parent.__stx_detached_if)
              currentNodes.forEach((node) => parent.__stx_detached_if.delete(node));
            el.__stx_if_visible.set(true);
            el.__stx_shown_at = performance.now();
            isInserted = true;
            peek(resumeDetachedBranches);
          } else if (!value && isInserted) {
            el.__stx_if_visible.set(false);
            currentNodes.forEach((node) => stxHost.remove(node));
            if (parent) {
              if (!parent.__stx_detached_if)
                parent.__stx_detached_if = new Set;
              currentNodes.forEach((node) => parent.__stx_detached_if.add(node));
            }
            isInserted = false;
          }
          if (value && isInserted && !childrenProcessed) {
            childrenProcessed = true;
            el.__stx_if_pending = true;
            var hydrateShownBranch = function() {
              if (!el.isConnected) {
                childrenProcessed = false;
                el.__stx_if_pending = false;
                var resume = function() {
                  if (!isInserted || childrenProcessed)
                    return;
                  childrenProcessed = true;
                  el.__stx_if_pending = true;
                  peek(hydrateShownBranch);
                };
                resume.el = el;
                detachedBranches.add(resume);
                return;
              }
              var childScope = { ...globalHelpers, ...capturedComponentScope, ...capturedElementScope || {} };
              var wasTrackedBeforeConditionalHydration = !!el.__stx_disposers;
              hydrateComponentScopes(currentNodes, childScope);
              if (wasTrackedBeforeConditionalHydration || !el.__stx_disposers)
                el.__stx_if_disposers = trackEffects(function() {
                  processElement(el, childScope);
                });
              el.removeAttribute("x-cloak");
              el.querySelectorAll("[x-cloak]").forEach(function(c) {
                c.removeAttribute("x-cloak");
              });
              el.__stx_if_pending = false;
              resumeDetachedBranches();
            };
            if (el.isConnected)
              queueMicrotask(function() {
                peek(hydrateShownBranch);
              });
            else
              setTimeout(hydrateShownBranch, 0);
          }
        }
      });
    }
    function $computed(fn) {
      return derived(fn);
    }
    function $watch(deps, fn) {
      effect(() => {
        const values = Array.isArray(deps) ? deps.map((d) => {
          if (typeof d === "function" && (d._isSignal || d._isDerived))
            return d();
          return d;
        }) : typeof deps === "function" && (deps._isSignal || deps._isDerived) ? [deps()] : [deps];
        fn(...values);
      });
    }
    var __stxProvided = Object.create(null);
    function provide(name, value) {
      __stxProvided[name] = value;
      window[name] = value;
    }
    function inject(name, defaultValue) {
      if (name in __stxProvided)
        return __stxProvided[name];
      if (name in window)
        return window[name];
      return defaultValue;
    }
    function useDebounce(fn, delay) {
      delay = delay || 250;
      var timer = null;
      var lastArgs = null;
      var debounced = function() {
        lastArgs = Array.prototype.slice.call(arguments);
        if (timer !== null)
          clearTimeout(timer);
        var args = lastArgs;
        timer = setTimeout(function() {
          timer = null;
          lastArgs = null;
          fn.apply(null, args);
        }, delay);
      };
      debounced.cancel = function() {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
          lastArgs = null;
        }
      };
      debounced.flush = function() {
        if (timer !== null && lastArgs !== null) {
          clearTimeout(timer);
          timer = null;
          var args = lastArgs;
          lastArgs = null;
          fn.apply(null, args);
        }
      };
      debounced.pending = function() {
        return timer !== null;
      };
      onDestroy(debounced.cancel);
      return debounced;
    }
    function useDebouncedValue(getter, delay) {
      delay = delay || 250;
      var current = getter();
      var listeners = [];
      var timer = null;
      function schedule() {
        if (timer !== null)
          clearTimeout(timer);
        timer = setTimeout(function() {
          timer = null;
          var next = getter();
          if (next !== current) {
            current = next;
            listeners.forEach(function(fn) {
              fn(current);
            });
          }
        }, delay);
      }
      schedule();
      onDestroy(function() {
        if (timer !== null)
          clearTimeout(timer);
        listeners = [];
      });
      return { get value() {
        return current;
      }, subscribe: function(fn) {
        listeners.push(fn);
        return function() {
          listeners = listeners.filter(function(f) {
            return f !== fn;
          });
        };
      } };
    }
    function useThrottle(fn, limit) {
      limit = limit || 250;
      var timer = null;
      var lastRan = 0;
      var throttled = function() {
        var args = Array.prototype.slice.call(arguments);
        var now = Date.now();
        var remaining = limit - (now - lastRan);
        if (remaining <= 0) {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          lastRan = now;
          fn.apply(null, args);
        } else if (timer === null) {
          timer = setTimeout(function() {
            lastRan = Date.now();
            timer = null;
            fn.apply(null, args);
          }, remaining);
        }
      };
      throttled.cancel = function() {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
      onDestroy(throttled.cancel);
      return throttled;
    }
    function useInterval(interval, options, thirdOptions) {
      var callback = null;
      if (typeof interval === "function") {
        callback = interval;
        if (typeof options === "number") {
          interval = options;
          options = thirdOptions || {};
        } else {
          interval = 1000;
          options = options && typeof options === "object" ? options : {};
        }
      }
      interval = interval || 1000;
      options = options || {};
      var count = 0;
      var id = null;
      var running = false;
      var listeners = [];
      function shouldTick() {
        if (options.whileVisible && typeof document !== "undefined" && document.hidden)
          return false;
        var en = options.enabled;
        if (typeof en === "function")
          return !!en();
        return en !== false;
      }
      function tick() {
        if (!shouldTick())
          return;
        count++;
        listeners.forEach(function(fn) {
          fn(count);
        });
      }
      function resume() {
        if (running)
          return;
        running = true;
        id = setInterval(tick, interval);
        if (options.immediate)
          tick();
      }
      function pause() {
        if (!running)
          return;
        running = false;
        if (id !== null) {
          clearInterval(id);
          id = null;
        }
      }
      function reset() {
        pause();
        count = 0;
        listeners.forEach(function(fn) {
          fn(count);
        });
        resume();
      }
      if (callback)
        listeners.push(callback);
      resume();
      onDestroy(function() {
        pause();
        listeners = [];
      });
      return { get counter() {
        return count;
      }, pause, resume, reset, subscribe: function(fn) {
        listeners.push(fn);
        return function() {
          listeners = listeners.filter(function(f) {
            return f !== fn;
          });
        };
      } };
    }
    function useTimeout(callback, delay) {
      delay = delay || 1000;
      var timer = null;
      var pending = false;
      var listeners = [];
      function setPending(v) {
        if (v !== pending) {
          pending = v;
          listeners.forEach(function(fn) {
            fn(pending);
          });
        }
      }
      function start() {
        stop();
        setPending(true);
        timer = setTimeout(function() {
          timer = null;
          setPending(false);
          callback();
        }, delay);
      }
      function stop() {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        setPending(false);
      }
      start();
      onDestroy(stop);
      return { get isPending() {
        return pending;
      }, start, stop, subscribe: function(fn) {
        listeners.push(fn);
        return function() {
          listeners = listeners.filter(function(f) {
            return f !== fn;
          });
        };
      } };
    }
    function useToggle(initial) {
      var current = !!initial;
      var listeners = [];
      function notify() {
        listeners.forEach(function(fn) {
          fn(current);
        });
      }
      function toggle() {
        current = !current;
        notify();
      }
      function set(v) {
        v = !!v;
        if (v !== current) {
          current = v;
          notify();
        }
      }
      var ref = { get value() {
        return current;
      }, subscribe: function(fn) {
        listeners.push(fn);
        return function() {
          listeners = listeners.filter(function(f) {
            return f !== fn;
          });
        };
      } };
      return [ref, toggle, set];
    }
    function useCounter(initial, options) {
      initial = initial || 0;
      options = options || {};
      var min = options.min != null ? options.min : -1 / 0;
      var max = options.max != null ? options.max : 1 / 0;
      function clamp(v) {
        return Math.min(max, Math.max(min, v));
      }
      var current = clamp(initial);
      var listeners = [];
      function notify() {
        listeners.forEach(function(fn) {
          fn(current);
        });
      }
      return { get count() {
        return current;
      }, inc: function(step) {
        current = clamp(current + (step || 1));
        notify();
      }, dec: function(step) {
        current = clamp(current - (step || 1));
        notify();
      }, set: function(v) {
        current = clamp(v);
        notify();
      }, reset: function() {
        current = clamp(initial);
        notify();
      }, subscribe: function(fn) {
        listeners.push(fn);
        return function() {
          listeners = listeners.filter(function(f) {
            return f !== fn;
          });
        };
      } };
    }
    function useClickOutside(target, handler) {
      function resolveTarget() {
        if (typeof target === "string")
          return document.querySelector(target);
        if (target && typeof target === "object") {
          if ("current" in target)
            return target.current;
          if ("value" in target)
            return target.value;
        }
        return target;
      }
      function listener(event) {
        var el = resolveTarget();
        if (!el)
          return;
        if (el === event.target || el.contains(event.target))
          return;
        handler(event);
      }
      document.addEventListener("pointerdown", listener, true);
      function remove() {
        document.removeEventListener("pointerdown", listener, true);
      }
      onDestroy(remove);
      return { remove };
    }
    function useFocus(target) {
      var focused = false;
      var listeners = [];
      function resolve() {
        return typeof target === "string" ? document.querySelector(target) : target;
      }
      function setFocused(v) {
        if (v !== focused) {
          focused = v;
          listeners.forEach(function(fn) {
            fn(focused);
          });
        }
      }
      var onFocusIn = function() {
        setFocused(true);
      };
      var onBlurOut = function() {
        setFocused(false);
      };
      var el = resolve();
      if (el) {
        el.addEventListener("focus", onFocusIn);
        el.addEventListener("blur", onBlurOut);
        focused = document.activeElement === el;
      }
      onDestroy(function() {
        var el = resolve();
        if (el) {
          el.removeEventListener("focus", onFocusIn);
          el.removeEventListener("blur", onBlurOut);
        }
        listeners = [];
      });
      return { get isFocused() {
        return focused;
      }, focus: function() {
        var el = resolve();
        if (el && el.focus)
          el.focus();
      }, blur: function() {
        var el = resolve();
        if (el && el.blur)
          el.blur();
      }, subscribe: function(fn) {
        listeners.push(fn);
        return function() {
          listeners = listeners.filter(function(f) {
            return f !== fn;
          });
        };
      } };
    }
    function nextTick(fn) {
      return Promise.resolve().then(function() {
        return new Promise(function(resolve) {
          setTimeout(function() {
            if (fn)
              fn();
            resolve();
          }, 0);
        });
      });
    }
    function watchMultiple(sources, callback, options) {
      options = options || {};
      var read = function() {
        return sources.map(function(s) {
          if (typeof s === "function")
            return s();
          if (s && typeof s === "object" && "value" in s)
            return s.value;
          return s;
        });
      };
      var oldValues = read();
      var first = true;
      return effect(function() {
        var newValues = read();
        if (first) {
          first = false;
          if (!options.immediate)
            return;
        }
        callback(newValues, oldValues);
        oldValues = newValues;
      });
    }
    function useAsync(fn, options) {
      options = options || {};
      var asyncState = "idle";
      var data = null;
      var error = null;
      var listeners = [];
      function notify() {
        var snap = { state: asyncState, data, error };
        listeners.forEach(function(fn) {
          fn(snap);
        });
      }
      function execute() {
        var args = Array.prototype.slice.call(arguments);
        asyncState = "loading";
        error = null;
        notify();
        return fn.apply(null, args).then(function(result) {
          data = result;
          asyncState = "success";
          notify();
          return data;
        }).catch(function(e) {
          error = e instanceof Error ? e : new Error(String(e));
          asyncState = "error";
          notify();
          return null;
        });
      }
      if (options.immediate)
        execute();
      return { get state() {
        return asyncState;
      }, get isLoading() {
        return asyncState === "loading";
      }, get error() {
        return error;
      }, get data() {
        return data;
      }, execute, subscribe: function(fn) {
        listeners.push(fn);
        return function() {
          listeners = listeners.filter(function(f) {
            return f !== fn;
          });
        };
      } };
    }
    function useColorMode(options) {
      options = options || {};
      var boot = null;
      try {
        boot = window.__STX_COLOR_MODE__ || null;
      } catch (e) {}
      function pick(a, b, fallback) {
        if (a !== undefined)
          return a;
        if (b !== undefined)
          return b;
        return fallback;
      }
      function fromBoot(key) {
        return boot && typeof boot === "object" ? boot[key] : undefined;
      }
      var storageKey = pick(options.storageKey, fromBoot("storageKey"), "stx-color-mode");
      var initialMode = pick(options.initialMode, fromBoot("initialMode"), "auto");
      var darkClass = pick(options.darkClass, fromBoot("darkClass"), "dark");
      var attribute = pick(options.attribute, fromBoot("attribute"), null);
      var autoValueOption = pick(options.autoValue, fromBoot("autoValue"), undefined);
      var disableTransitions = options.disableTransitions !== false;
      var respectExisting = options.respectExisting === true || fromBoot("respectExisting") === true;
      var bootForced = fromBoot("forced");
      var forcedMode = respectExisting && (bootForced === "light" || bootForced === "dark") ? bootForced : null;
      var resolved = "light";
      var listeners = [];
      var cleanups = [];
      function normalizeMode(v) {
        if (v === "light" || v === "dark")
          return v;
        if (v === "auto" || v === "system")
          return "auto";
        return null;
      }
      var preference = normalizeMode(initialMode) || "auto";
      function getSystem() {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      function resolve(pref) {
        return pref === "auto" ? getSystem() : pref;
      }
      function effective(pref) {
        return forcedMode || resolve(pref);
      }
      function applyDOM(mode) {
        var el = document.documentElement;
        if (disableTransitions)
          el.style.setProperty("transition", "none", "important");
        if (attribute)
          el.setAttribute(attribute, mode);
        if (darkClass) {
          if (mode === "dark")
            el.classList.add(darkClass);
          else
            el.classList.remove(darkClass);
        }
        if (disableTransitions) {
          el.offsetHeight;
          el.style.removeProperty("transition");
        }
      }
      function readRaw() {
        try {
          return localStorage.getItem(storageKey);
        } catch (e) {
          return null;
        }
      }
      var storedRaw = readRaw();
      var autoValue = autoValueOption !== undefined ? autoValueOption : storedRaw === "auto" || storedRaw === "system" ? storedRaw : "auto";
      function persist(pref) {
        try {
          localStorage.setItem(storageKey, pref === "auto" ? autoValue : pref);
        } catch (e) {}
      }
      function update(pref, persistChoice) {
        preference = normalizeMode(pref) || "auto";
        resolved = effective(preference);
        applyDOM(resolved);
        if (persistChoice !== false)
          persist(preference);
        listeners.forEach(function(fn) {
          fn(resolved, preference);
        });
      }
      update(normalizeMode(storedRaw) || initialMode, false);
      var mql = window.matchMedia("(prefers-color-scheme: dark)");
      var onSystemChange = function() {
        if (preference === "auto") {
          resolved = forcedMode || getSystem();
          applyDOM(resolved);
          listeners.forEach(function(fn) {
            fn(resolved, preference);
          });
        }
      };
      mql.addEventListener("change", onSystemChange);
      cleanups.push(function() {
        mql.removeEventListener("change", onSystemChange);
      });
      var onStorage = function(e) {
        if (e.key !== storageKey)
          return;
        var v = normalizeMode(e.newValue);
        if (v) {
          if (v === "auto" && (e.newValue === "auto" || e.newValue === "system"))
            autoValue = e.newValue;
          preference = v;
          resolved = effective(v);
          applyDOM(resolved);
          listeners.forEach(function(fn) {
            fn(resolved, preference);
          });
        }
      };
      window.addEventListener("storage", onStorage);
      cleanups.push(function() {
        window.removeEventListener("storage", onStorage);
      });
      onDestroy(function() {
        cleanups.forEach(function(fn) {
          fn();
        });
        listeners = [];
      });
      return { get mode() {
        return resolved;
      }, get preference() {
        return preference;
      }, get isDark() {
        return resolved === "dark";
      }, set: function(mode) {
        update(mode);
      }, toggle: function() {
        update(resolved === "dark" ? "light" : "dark");
      }, subscribe: function(fn) {
        listeners.push(fn);
        return function() {
          listeners = listeners.filter(function(f) {
            return f !== fn;
          });
        };
      } };
    }
    function useDark(options) {
      var cm = useColorMode(options);
      var dark = state(cm.isDark);
      var setSignal = dark.set;
      cm.subscribe(function(mode) {
        setSignal(mode === "dark");
      });
      dark.toggle = function() {
        cm.toggle();
      };
      dark.set = function(value) {
        cm.set(value ? "dark" : "light");
      };
      Object.defineProperty(dark, "isDark", { get: function() {
        return dark();
      } });
      return dark;
    }
    function useMediaQuery(query) {
      var mql = window.matchMedia(query);
      var matches = state(mql.matches);
      var onChange = function(event) {
        matches.set(event.matches);
      };
      if (mql.addEventListener)
        mql.addEventListener("change", onChange);
      else if (mql.addListener)
        mql.addListener(onChange);
      onDestroy(function() {
        if (mql.removeEventListener)
          mql.removeEventListener("change", onChange);
        else if (mql.removeListener)
          mql.removeListener(onChange);
      });
      Object.defineProperty(matches, "matches", { get: function() {
        return matches();
      } });
      Object.defineProperty(matches, "value", { get: function() {
        return matches();
      } });
      return matches;
    }
    function useDocumentVisibility() {
      var visibility = state(typeof document !== "undefined" ? document.visibilityState : "visible");
      if (typeof document === "undefined")
        return visibility;
      var onChange = function() {
        visibility.set(document.visibilityState);
      };
      document.addEventListener("visibilitychange", onChange);
      onDestroy(function() {
        document.removeEventListener("visibilitychange", onChange);
      });
      return visibility;
    }
    var scrollLockStates = new WeakMap;
    function resolveScrollLockTarget(target) {
      var value = target;
      if (typeof value === "function")
        value = value();
      if (value && typeof value === "object" && "current" in value)
        value = value.current;
      if (value && typeof value === "object" && !value.nodeType && "value" in value)
        value = value.value;
      return value || document.body || document.documentElement;
    }
    function acquireScrollLock(element) {
      if (!element)
        return;
      var existing = scrollLockStates.get(element);
      if (existing) {
        existing.count += 1;
        return;
      }
      scrollLockStates.set(element, { count: 1, overflow: element.style.overflow });
      element.style.overflow = "hidden";
    }
    function releaseScrollLock(element) {
      if (!element)
        return;
      var existing = scrollLockStates.get(element);
      if (!existing)
        return;
      existing.count -= 1;
      if (existing.count > 0)
        return;
      element.style.overflow = existing.overflow;
      scrollLockStates.delete(element);
    }
    function useScrollLock(target) {
      var locked = state(false);
      var lockedElement = null;
      var unsubscribe = locked.subscribe(function(value) {
        if (value) {
          if (lockedElement)
            return;
          lockedElement = resolveScrollLockTarget(target);
          acquireScrollLock(lockedElement);
        } else if (lockedElement) {
          releaseScrollLock(lockedElement);
          lockedElement = null;
        }
      });
      onDestroy(function() {
        unsubscribe();
        if (lockedElement) {
          releaseScrollLock(lockedElement);
          lockedElement = null;
        }
      });
      return locked;
    }
    function usePreferredDark() {
      return useMediaQuery("(prefers-color-scheme: dark)");
    }
    function usePreferredLight() {
      return useMediaQuery("(prefers-color-scheme: light)");
    }
    function usePreferredReducedMotion() {
      return useMediaQuery("(prefers-reduced-motion: reduce)");
    }
    function usePreferredContrast() {
      return useMediaQuery("(prefers-contrast: more)");
    }
    var ref = state;
    var __stxReactiveProxies = new WeakMap;
    function reactive(target) {
      if (!target || typeof target !== "object")
        return target;
      var existing = __stxReactiveProxies.get(target);
      if (existing)
        return existing;
      var propSignals = Object.create(null);
      function signalFor(prop) {
        if (!propSignals[prop])
          propSignals[prop] = state(target[prop]);
        return propSignals[prop];
      }
      var proxy = new Proxy(target, { get: function(t, prop, receiver) {
        if (typeof prop === "symbol" || !Object.prototype.hasOwnProperty.call(t, prop))
          return Reflect.get(t, prop, receiver);
        var value = signalFor(prop)();
        return value && typeof value === "object" ? reactive(value) : value;
      }, set: function(t, prop, value) {
        if (typeof prop === "symbol")
          return Reflect.set(t, prop, value);
        var had = Object.prototype.hasOwnProperty.call(t, prop);
        t[prop] = value;
        if (propSignals[prop])
          propSignals[prop].set(value);
        else if (had)
          signalFor(prop);
        return true;
      }, deleteProperty: function(t, prop) {
        var had = Object.prototype.hasOwnProperty.call(t, prop);
        delete t[prop];
        if (had && propSignals[prop])
          propSignals[prop].set(undefined);
        return true;
      } });
      __stxReactiveProxies.set(target, proxy);
      return proxy;
    }
    var computed = derived;
    var watch = $watch;
    var watchEffect = function(fn) {
      return effect(fn);
    };
    function stxParseStored(raw, fallback, key, label) {
      if (raw === null || raw === undefined)
        return fallback;
      try {
        return JSON.parse(raw);
      } catch (e) {
        console.warn("[stx] " + label + ': "' + key + '" holds a value that is not JSON (' + String(raw).slice(0, 64) + "); using it as a raw string. Write it with the same composable to store it as JSON.");
        return raw;
      }
    }
    function stxStorageRead(store, key, fallback, label) {
      var raw;
      try {
        raw = store.getItem(key);
      } catch (e) {
        console.warn("[stx] " + label + ': cannot read "' + key + '" (' + (e && e.message ? e.message : e) + "); using the default.");
        return fallback;
      }
      return stxParseStored(raw, fallback, key, label);
    }
    function stxStorageWrite(store, key, value, label) {
      try {
        store.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.warn("[stx] " + label + ': cannot persist "' + key + '" (' + (e && e.message ? e.message : e) + "); the value stays in memory only.");
      }
    }
    function useLocalStorage(key, defaultValue) {
      var s = state(stxStorageRead(localStorage, key, defaultValue, "useLocalStorage"));
      effect(function() {
        stxStorageWrite(localStorage, key, s(), "useLocalStorage");
      });
      var handler = function(e) {
        if (e.key === key && (!e.storageArea || e.storageArea === localStorage))
          s.set(stxParseStored(e.newValue, defaultValue, key, "useLocalStorage"));
      };
      window.addEventListener("storage", handler);
      onDestroy(function() {
        window.removeEventListener("storage", handler);
      });
      return s;
    }
    function useSessionStorage(key, defaultValue) {
      var s = state(stxStorageRead(sessionStorage, key, defaultValue, "useSessionStorage"));
      effect(function() {
        stxStorageWrite(sessionStorage, key, s(), "useSessionStorage");
      });
      var handler = function(e) {
        if (e.key === key && (!e.storageArea || e.storageArea === sessionStorage))
          s.set(stxParseStored(e.newValue, defaultValue, key, "useSessionStorage"));
      };
      window.addEventListener("storage", handler);
      onDestroy(function() {
        window.removeEventListener("storage", handler);
      });
      return s;
    }
    var STX_KEPT_PREFIX = "stx:kept:";
    var __stxKept = function createKeptStore(options, openBackend) {
      const opts = options || {};
      let storage = null;
      if (opts.storage !== undefined)
        storage = opts.storage;
      else
        try {
          storage = typeof localStorage < "u" ? localStorage : null;
        } catch {
          storage = null;
        }
      let backend = null, backendOpened = opts.backend !== undefined;
      if (backendOpened)
        backend = opts.backend || null;
      const useBackend = () => {
        if (backendOpened)
          return backend;
        backendOpened = true;
        try {
          backend = openBackend ? openBackend() : null;
        } catch {
          backend = null;
        }
        if (backend) {
          const probe = backend;
          probe.get("__stx_probe__").catch(() => {
            if (backend === probe)
              backend = null;
          });
        }
        return backend;
      }, limit = opts.limit || 32768, defer = opts.defer || ((fn) => {
        const idle = typeof requestIdleCallback === "function" ? requestIdleCallback : null;
        if (idle)
          idle(fn, { timeout: 200 });
        else
          setTimeout(fn, 16);
      }), memory = new Map, inBackend = new Set, waiting = new Map;
      let scheduled = false, writes = Promise.resolve();
      const parse = (raw) => {
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      }, writeStorage = (key, json) => {
        if (!storage)
          return false;
        try {
          storage.setItem(key, json);
          return true;
        } catch {
          return false;
        }
      }, removeStorage = (key) => {
        try {
          if (storage)
            storage.removeItem(key);
        } catch {}
      }, drain = () => {
        scheduled = false;
        if (!waiting.size)
          return writes;
        const batch = Array.from(waiting.entries());
        waiting.clear();
        writes = writes.then(() => Promise.all(batch.map(([key, value]) => {
          if (!backend) {
            inBackend.delete(key);
            try {
              writeStorage(key, JSON.stringify(value === undefined ? null : value));
            } catch {}
            return;
          }
          let record;
          try {
            record = { v: value };
            return backend.set(key, record).catch(() => {
              let json;
              try {
                json = JSON.stringify(value);
              } catch {
                return;
              }
              return backend ? backend.set(key, { j: json }).catch(() => {
                writeStorage(key, json);
              }) : undefined;
            });
          } catch {
            return;
          }
        }))).then(() => {});
        return writes;
      }, schedule = (key, value) => {
        waiting.set(key, value);
        inBackend.add(key);
        if (scheduled)
          return;
        scheduled = true;
        defer(() => {
          drain();
        });
      }, unwrap = (record) => {
        if (!record || typeof record !== "object")
          return;
        const r = record;
        if ("v" in r)
          return { value: r.v };
        if (typeof r.j === "string")
          return { value: parse(r.j) };
        return;
      }, store = { peek(key) {
        if (memory.has(key))
          return { value: memory.get(key) };
        let raw = null;
        try {
          raw = storage ? storage.getItem(key) : null;
        } catch {
          raw = null;
        }
        if (raw === null || raw === undefined)
          return;
        const value = parse(raw);
        memory.set(key, value);
        return { value };
      }, load(key) {
        const hit = store.peek(key), from = hit ? null : useBackend();
        if (hit || !from)
          return Promise.resolve(hit);
        return from.get(key).then((record) => {
          if (memory.has(key))
            return { value: memory.get(key) };
          const found = unwrap(record);
          if (found) {
            memory.set(key, found.value);
            inBackend.add(key);
          }
          return found;
        }, () => {
          return;
        });
      }, set(key, value) {
        memory.set(key, value);
        if (backend && inBackend.has(key)) {
          schedule(key, value);
          return;
        }
        let json;
        try {
          json = JSON.stringify(value === undefined ? null : value);
        } catch {
          return;
        }
        if (json.length <= limit && writeStorage(key, json))
          return;
        if (!useBackend()) {
          if (json.length > limit)
            writeStorage(key, json);
          return;
        }
        removeStorage(key);
        schedule(key, value);
      }, forget(prefix) {
        for (const key of Array.from(memory.keys()))
          if (key.indexOf(prefix) === 0)
            memory.delete(key);
        for (const key of Array.from(waiting.keys()))
          if (key.indexOf(prefix) === 0)
            waiting.delete(key);
        for (const key of Array.from(inBackend))
          if (key.indexOf(prefix) === 0)
            inBackend.delete(key);
        try {
          if (storage)
            for (let i = storage.length - 1;i >= 0; i--) {
              const key = storage.key(i);
              if (key && key.indexOf(prefix) === 0)
                storage.removeItem(key);
            }
        } catch {}
        const gone = useBackend();
        if (!gone)
          return writes;
        writes = writes.then(() => gone.removePrefix(prefix)).catch(() => {});
        return writes;
      }, flush() {
        return drain();
      } };
      try {
        if (typeof document < "u" && document.addEventListener)
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden")
              drain();
          });
        if (typeof addEventListener === "function")
          addEventListener("pagehide", () => {
            drain();
          });
      } catch {}
      return store;
    }(undefined, function indexedDbBackend(name) {
      let factory = null;
      try {
        factory = typeof indexedDB < "u" ? indexedDB : null;
      } catch {
        factory = null;
      }
      if (!factory)
        return null;
      const idb = factory, dbName = name || "stx-kept";
      let opened = null;
      const open = () => {
        if (!opened) {
          opened = new Promise((resolve, reject) => {
            const request = idb.open(dbName, 1);
            request.onupgradeneeded = () => {
              request.result.createObjectStore("kv");
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(Error("blocked"));
          });
          opened.catch(() => {
            opened = null;
          });
        }
        return opened;
      }, run = (mode, fn) => open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction("kv", mode), request = fn(tx.objectStore("kv"));
        tx.oncomplete = () => resolve(request ? request.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }));
      return { get: (key) => run("readonly", (store) => store.get(key)), set: (key, value) => run("readwrite", (store) => {
        store.put(value, key);
      }), remove: (key) => run("readwrite", (store) => {
        store.delete(key);
      }), removePrefix: (prefix) => run("readwrite", (store) => {
        store.delete(IDBKeyRange.bound(prefix, `${prefix}￿`));
      }) };
    });
    var __stxQueries = function createQueryCache(env) {
      const prefix = env.prefix || "stx:kept:", matches = env.matches || ((item, target) => item === target.key || item === target.url), watchers = new Set, queries = new Map;
      let defaultScope;
      const resolveScope = (scope) => scope === undefined ? defaultScope : scope, keyFor = (key, scope) => {
        const s = resolveScope(scope);
        if (s === false || s === null || s === "")
          return null;
        return `${prefix}${s === undefined ? "" : `${s}:`}query:${key}`;
      }, unpack = (found) => {
        const record = found && found.value;
        if (!record || typeof record !== "object" || !("d" in record))
          return;
        return { data: record.d, at: Number(record.at) || 0 };
      }, outboxes = () => {
        const g = globalThis;
        return g.__stx_outboxes instanceof Map ? g.__stx_outboxes : null;
      }, cache = { setScope(scope) {
        defaultScope = scope;
      }, scope: () => defaultScope, keyFor, seed(key, scope) {
        const at = keyFor(key, scope);
        return at ? unpack(env.kept.peek(at)) : undefined;
      }, restore(key, scope) {
        const at = keyFor(key, scope);
        return at ? env.kept.load(at).then(unpack) : Promise.resolve(undefined);
      }, persist(key, data, scope) {
        const at = keyFor(key, scope);
        if (at)
          env.kept.set(at, { d: data, at: Date.now() });
      }, overlay(target, data, onlyId) {
        const boxes = outboxes();
        if (!boxes || !boxes.size)
          return data;
        let out = data;
        boxes.forEach((box) => {
          try {
            out = box.overlay(target, out, onlyId);
          } catch {}
        });
        return out;
      }, watch(watcher) {
        watchers.add(watcher);
        return () => {
          watchers.delete(watcher);
        };
      }, cachedQuery(key, options) {
        const existing = queries.get(key);
        if (existing) {
          if (options && existing.__options)
            existing.__options(options);
          return existing;
        }
        let opts = options || {};
        const initial = opts.initial === undefined ? null : opts.initial, scopeNow = () => typeof opts.scope === "function" ? opts.scope() : opts.scope, urlNow = () => {
          return (typeof opts.url === "function" ? opts.url() : opts.url) || null;
        }, target = () => ({ key, url: urlNow() });
        let scope = scopeNow(), base = initial, fetchedAt = 0, inflight = null;
        const seeded = cache.seed(key, scope);
        if (seeded)
          base = seeded.data;
        const data = env.state(cache.overlay(target(), base)), loading = env.state(false), isFetching = env.state(false), error = env.state(null), updatedAt = env.state(seeded ? seeded.at : 0);
        let generation = 0;
        const show = () => {
          data.set(cache.overlay(target(), base));
        }, restoreFrom = (from) => {
          const asked = generation;
          cache.restore(key, from).then((found) => {
            if (!found || asked !== generation || fetchedAt)
              return;
            base = found.data;
            updatedAt.set(found.at);
            show();
          });
        };
        if (!seeded)
          restoreFrom(scope);
        const followScope = () => {
          const now = scopeNow();
          if (now === scope)
            return;
          scope = now;
          generation++;
          inflight = null;
          fetchedAt = 0;
          const found = cache.seed(key, scope);
          base = found ? found.data : initial;
          updatedAt.set(found ? found.at : 0);
          show();
          if (!found)
            restoreFrom(scope);
        }, request = (force) => {
          const url = urlNow(), timeout = opts.timeoutMs || 15000, controller = typeof AbortController < "u" ? new AbortController : null;
          let timer = null;
          const expired = new Promise((_, reject) => {
            timer = setTimeout(() => {
              if (controller)
                controller.abort();
              reject(Error("The request took too long."));
            }, timeout);
          });
          let work;
          if (opts.load)
            work = opts.load({ force, url, signal: controller ? controller.signal : undefined });
          else if (url) {
            const send = opts.fetch || ((u, init) => fetch(u, init)), init = { method: "GET", headers: { Accept: "application/json" } };
            if (force)
              init.cache = "no-cache";
            if (controller)
              init.signal = controller.signal;
            work = send(url, init).then((response) => {
              if (!response.ok)
                return response.json().catch(() => null).then((body) => {
                  throw Error(body && (body.error || body.message) || `Request failed (${response.status})`);
                });
              return response.json();
            });
          } else
            return Promise.resolve(data());
          return Promise.race([work, expired]).then((raw) => {
            if (timer)
              clearTimeout(timer);
            return opts.transform ? opts.transform(raw) : raw;
          }, (cause) => {
            if (timer)
              clearTimeout(timer);
            throw cause;
          });
        }, run = (force) => {
          if (inflight)
            return inflight;
          const asked = generation;
          isFetching.set(true);
          if (fetchedAt === 0 && !updatedAt())
            loading.set(true);
          const done = () => {
            if (asked !== generation)
              return;
            inflight = null;
            isFetching.set(false);
            loading.set(false);
          }, promise = request(force).then((value) => {
            if (asked !== generation)
              return data();
            base = value;
            fetchedAt = Date.now();
            updatedAt.set(fetchedAt);
            error.set(null);
            cache.persist(key, value, scope);
            show();
            done();
            return data();
          }, (cause) => {
            if (asked === generation)
              error.set(cause && cause.message ? cause.message : "Could not load.");
            done();
            return data();
          });
          inflight = promise;
          return promise;
        }, query = { data, loading, isFetching, error, updatedAt, get key() {
          return key;
        }, load(force) {
          followScope();
          if (!force && fetchedAt && Date.now() - fetchedAt < (opts.staleTime || 0))
            return Promise.resolve(data());
          return run(!!force);
        }, refresh() {
          return query.load(true);
        }, set(value) {
          base = typeof value === "function" ? value(base) : value;
          cache.persist(key, base, scope);
          show();
        }, invalidate() {
          fetchedAt = 0;
        }, __options(next) {
          opts = { ...opts, ...next };
        } };
        watchers.add({ target, updated: () => {
          if (fetchedAt || updatedAt())
            run(false);
        }, outbox: (sent) => {
          if (sent) {
            base = cache.overlay(target(), base, sent.id);
            fetchedAt = 0;
            run(true);
          }
          show();
        } });
        queries.set(key, query);
        if (opts.immediate)
          query.load();
        return query;
      } }, events = typeof window < "u" ? window : typeof addEventListener === "function" ? globalThis : null;
      if (env.listen !== false && events && typeof events.addEventListener === "function") {
        events.addEventListener("stx:updated", (event) => {
          const detail = event.detail || {};
          if (detail.kind !== "api" || typeof detail.url !== "string")
            return;
          watchers.forEach((watcher) => {
            if (matches(detail.url, watcher.target()))
              watcher.updated();
          });
        });
        events.addEventListener("stx:outbox", (event) => {
          const detail = event.detail || {}, sent = detail.sent && typeof detail.sent.id === "string" ? detail.sent : null;
          watchers.forEach((watcher) => {
            if (sent) {
              const affects = Array.isArray(sent.affects) ? sent.affects : [], t = watcher.target();
              if (!affects.some((item) => matches(item, t)))
                return;
            }
            watcher.outbox(sent);
          });
        });
      }
      return cache;
    }({ state, kept: __stxKept, prefix: STX_KEPT_PREFIX, matches: function queryTargetMatches(item, target) {
      if (!item)
        return false;
      if (item === target.key)
        return true;
      if (!target.url)
        return false;
      if (item === target.url)
        return true;
      try {
        const base = typeof location < "u" && location.origin && location.origin !== "null" ? location.origin : "http://localhost", a = new URL(item, base), b = new URL(target.url, base);
        if (a.origin !== b.origin || a.pathname !== b.pathname)
          return false;
        return !a.search || a.search === b.search;
      } catch {
        return false;
      }
    } });
    function stxKeptPrefix(scope) {
      return STX_KEPT_PREFIX + (scope === undefined || scope === null || scope === "" ? "" : String(scope) + ":");
    }
    function keptState(name, initialValue, options) {
      var scope = options ? options.scope : undefined;
      if (scope === undefined)
        scope = __stxQueries.scope();
      if (scope === false || scope === null || scope === "")
        return state(initialValue);
      var key = stxKeptPrefix(scope) + name;
      var hit = __stxKept.peek(key);
      var s = state(hit ? hit.value : initialValue);
      var restored = {};
      var touched = false;
      s.subscribe(function(value) {
        if (value === restored)
          return;
        touched = true;
        __stxKept.set(key, value);
      });
      if (!hit) {
        __stxKept.load(key).then(function(found) {
          if (!found || touched)
            return;
          restored = found.value;
          s.set(found.value);
        });
      }
      return s;
    }
    function forgetKeptState(scope) {
      return __stxKept.forget(stxKeptPrefix(scope));
    }
    function setKeptScope(scope) {
      __stxQueries.setScope(scope);
    }
    function flushKeptState() {
      return __stxKept.flush();
    }
    function cachedQuery(key, options) {
      return __stxQueries.cachedQuery(key, options);
    }
    function useCookie(name, opts) {
      opts = opts || {};
      var encode = opts.encode || encodeURIComponent;
      var decode = opts.decode || decodeURIComponent;
      var escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var nameRe = new RegExp("(?:^|; )" + escapedName + "=([^;]*)");
      function read() {
        if (typeof document === "undefined")
          return opts.defaultValue || "";
        var m = document.cookie.match(nameRe);
        return m ? decode(m[1]) : opts.defaultValue || "";
      }
      var s = state(read());
      function serialise(value) {
        var parts = [name + "=" + (value ? encode(value) : "")];
        parts.push("path=" + (opts.path || "/"));
        if (opts.domain)
          parts.push("domain=" + opts.domain);
        if (value === "")
          parts.push("max-age=0");
        else if (typeof opts.maxAge === "number")
          parts.push("max-age=" + opts.maxAge);
        else if (opts.expires !== undefined) {
          var expiresDate = opts.expires instanceof Date ? opts.expires : typeof opts.expires === "number" ? new Date(Date.now() + opts.expires * 1000) : new Date(opts.expires);
          parts.push("expires=" + expiresDate.toUTCString());
        }
        parts.push("SameSite=" + (opts.sameSite || "Lax"));
        var secure = opts.secure;
        if (secure === undefined)
          secure = typeof location !== "undefined" && location.protocol === "https:";
        if (secure)
          parts.push("Secure");
        return parts.join("; ");
      }
      s.subscribe(function(value) {
        if (typeof document === "undefined")
          return;
        document.cookie = serialise(value);
      });
      return s;
    }
    var __stxGeneratedIdCounter = 0;
    function useId(prefix) {
      var normalizedPrefix = String(prefix || "stx").trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "stx";
      var root = window.__STX_CURRENT_ELEMENT__;
      if (root && root.getAttribute) {
        var scopeId = root.getAttribute("data-stx-scope") || root.getAttribute("data-stx") || "";
        if (scopeId) {
          root.__stx_id_counter = (root.__stx_id_counter || 0) + 1;
          return normalizedPrefix + "-" + String(scopeId).replace(/[^a-zA-Z0-9_-]+/g, "-") + "-" + root.__stx_id_counter;
        }
      }
      __stxGeneratedIdCounter++;
      return normalizedPrefix + "-" + __stxGeneratedIdCounter;
    }
    var createModelSignal = function createModelSignal(source, modifiers, emit, options, cleanup) {
      let active = true;
      const subscriptions = new Set, read = (value) => options.get ? options.get(value) : value, model = () => read(source());
      Object.defineProperty(model, "_isSignal", { value: true });
      Object.defineProperty(model, "modifiers", { get: modifiers });
      model.set = (value) => {
        if (!active)
          return;
        const flags = modifiers();
        let next = options.set ? options.set(value, flags) : value;
        if (flags.trim && typeof next === "string")
          next = next.trim();
        if (flags.number && typeof next === "string" && next !== "") {
          const number = Number(next);
          if (!Number.isNaN(number))
            next = number;
        }
        if (Object.is(source(), next))
          return;
        source.set(next);
        emit(next);
      };
      model.update = (fn) => model.set(fn(model()));
      model.input = (value) => {
        if (!modifiers().lazy)
          model.set(value);
      };
      model.change = (value) => {
        if (modifiers().lazy)
          model.set(value);
      };
      model.subscribe = (callback) => {
        if (!active)
          return () => {};
        const unsubscribe = source.subscribe((value, previous) => callback(read(value), read(previous)));
        subscriptions.add(unsubscribe);
        return () => {
          unsubscribe();
          subscriptions.delete(unsubscribe);
        };
      };
      Object.defineProperty(model, "value", { get: model, set: model.set });
      cleanup(() => {
        active = false;
        subscriptions.forEach((unsubscribe) => unsubscribe());
        subscriptions.clear();
      });
      return model;
    };
    function useModel(name, options) {
      if (typeof name !== "string") {
        options = name || {};
        name = "modelValue";
      }
      options = options || {};
      var source = useReactiveProp(name, options.default, { parse: options.parse });
      var modifierName = name === "modelValue" ? "modelModifiers" : name + "Modifiers";
      var modifiers = useReactiveProp(modifierName, {});
      var emit = window.stx.defineEmits(["update:" + name]);
      return createModelSignal(source, function() {
        return modifiers() || {};
      }, function(value) {
        emit("update:" + name, value);
      }, options, onDestroy);
    }
    function useReactiveProp(name, defaultValue, opts) {
      opts = opts || {};
      var parse = opts.parse || function(v) {
        if (typeof defaultValue === "string")
          return v == null ? "" : String(v);
        if (typeof defaultValue === "boolean") {
          if (v === "" || v === "true")
            return true;
          if (v === "false" || v === null || v === undefined)
            return false;
          return Boolean(v);
        }
        if (v === "" || v === "true")
          return true;
        if (v === "false")
          return false;
        if (typeof v === "string" && (v.charAt(0) === "[" || v.charAt(0) === "{")) {
          try {
            return JSON.parse(v);
          } catch (e) {}
        }
        if (typeof defaultValue === "number")
          return v != null && v !== "" && !isNaN(Number(v)) ? Number(v) : defaultValue;
        if (v != null && v !== "" && !isNaN(Number(v)))
          return Number(v);
        return v;
      };
      var root = window.__STX_CURRENT_ELEMENT__;
      var kebabName = name.replace(/([A-Z])/g, function(_, c) {
        return "-" + c.toLowerCase();
      });
      var lowerName = name.toLowerCase();
      var attributeNames = [name];
      if (kebabName !== name)
        attributeNames.push(kebabName);
      if (lowerName !== name && lowerName !== kebabName)
        attributeNames.push(lowerName);
      function readAttribute() {
        if (!root || !root.hasAttribute)
          return { has: false, raw: null };
        for (var i = 0;i < attributeNames.length; i++) {
          var candidate = attributeNames[i];
          if (root.hasAttribute(candidate))
            return { has: true, raw: root.getAttribute(candidate) };
        }
        return { has: false, raw: null };
      }
      var staticValue = defaultValue;
      if (root && root.getAttribute) {
        var serializedProps = root.getAttribute("data-stx-props");
        if (serializedProps) {
          try {
            var parsedProps = JSON.parse(serializedProps);
            var camelName = name.replace(/-([a-z0-9])/g, function(_, c) {
              return c.toUpperCase();
            });
            if (Object.prototype.hasOwnProperty.call(parsedProps, name))
              staticValue = parsedProps[name];
            else if (Object.prototype.hasOwnProperty.call(parsedProps, camelName))
              staticValue = parsedProps[camelName];
          } catch (e) {}
        }
      }
      var initial;
      var lastRaw = null;
      var initialAttribute = readAttribute();
      if (initialAttribute.has) {
        lastRaw = initialAttribute.raw;
        initial = parse(lastRaw);
      } else {
        initial = staticValue;
      }
      var s = state(initial);
      if (!root)
        return s;
      var propSignals = root.__stx_reactive_prop_signals || (root.__stx_reactive_prop_signals = {});
      propSignals[name] = s;
      propSignals[kebabName] = s;
      propSignals[lowerName] = s;
      var observer = new MutationObserver(function() {
        var attribute = readAttribute();
        var hasAttr = attribute.has;
        var raw = attribute.raw;
        if (raw === lastRaw)
          return;
        lastRaw = raw;
        var directValues = root.__stx_direct_prop_values;
        var directValue = directValues && directValues[name];
        var next;
        if (directValue && directValue.raw === raw) {
          next = directValue.value;
          delete directValues[name];
          for (var directKey in directValues) {
            if (directValues[directKey] === directValue)
              delete directValues[directKey];
          }
        } else {
          next = hasAttr ? parse(raw) : staticValue;
        }
        if (next !== s())
          s.set(next);
      });
      observer.observe(root, { attributes: true, attributeFilter: attributeNames });
      onDestroy(function() {
        observer.disconnect();
        attributeNames.forEach(function(attributeName) {
          if (propSignals[attributeName] === s)
            delete propSignals[attributeName];
        });
      });
      return s;
    }
    function useEventListener(event, handler, options) {
      var target = options && options.target || window;
      if (typeof target === "string")
        target = document.querySelector(target);
      if (!target)
        return;
      var opts = { capture: options && options.capture, passive: options && options.passive, once: options && options.once };
      target.addEventListener(event, handler, opts);
      onDestroy(function() {
        target.removeEventListener(event, handler, opts);
      });
    }
    function useHead(config) {
      function apply() {
        if (config.title)
          document.title = config.title;
        var metas = config.meta || [];
        for (var i = 0;i < metas.length; i++) {
          var m = metas[i];
          if (!m.name && !m.property)
            continue;
          var selector = m.name ? 'meta[name="' + m.name + '"]' : 'meta[property="' + m.property + '"]';
          var el = document.querySelector(selector);
          if (el) {
            el.setAttribute("content", m.content || "");
          } else {
            el = document.createElement("meta");
            if (m.name)
              el.setAttribute("name", m.name);
            if (m.property)
              el.setAttribute("property", m.property);
            el.setAttribute("content", m.content || "");
            document.head.appendChild(el);
          }
        }
        var links = config.link || config.links || [];
        for (var j = 0;j < links.length; j++) {
          var l = links[j];
          if (!l.rel || !l.href)
            continue;
          var linkSel = 'link[rel="' + l.rel + '"][href="' + l.href + '"]';
          if (!document.querySelector(linkSel)) {
            var le = document.createElement("link");
            for (var k in l) {
              if (l.hasOwnProperty(k))
                le.setAttribute(k, l[k]);
            }
            document.head.appendChild(le);
          }
        }
        var scripts = config.script || config.scripts || [];
        for (var si = 0;si < scripts.length; si++) {
          var s = scripts[si];
          var se = document.createElement("script");
          if (s.src)
            se.src = s.src;
          if (s.innerHTML)
            se.innerHTML = s.innerHTML;
          if (s.async)
            se.async = true;
          if (s.defer)
            se.defer = true;
          document.head.appendChild(se);
        }
        if (config.bodyAttrs && config.bodyAttrs.class) {
          config.bodyAttrs.class.split(" ").forEach(function(cls) {
            if (cls)
              document.body.classList.add(cls);
          });
        }
        if (config.htmlAttrs) {
          for (var hk in config.htmlAttrs) {
            if (!config.htmlAttrs.hasOwnProperty(hk))
              continue;
            var hv = config.htmlAttrs[hk];
            if (hv == null)
              continue;
            if (hk === "class") {
              String(hv).split(" ").forEach(function(cls) {
                if (cls)
                  document.documentElement.classList.add(cls);
              });
            } else {
              document.documentElement.setAttribute(hk, hv);
            }
          }
        }
      }
      if (document.readyState !== "loading") {
        apply();
      } else {
        onMount(apply);
      }
    }
    function useSeoMeta(config) {
      var meta = [];
      if (config.title)
        meta.push({ name: "title", content: config.title });
      if (config.description)
        meta.push({ name: "description", content: config.description });
      if (config.ogTitle)
        meta.push({ property: "og:title", content: config.ogTitle });
      if (config.ogDescription)
        meta.push({ property: "og:description", content: config.ogDescription });
      if (config.ogImage)
        meta.push({ property: "og:image", content: config.ogImage });
      if (config.ogType)
        meta.push({ property: "og:type", content: config.ogType });
      if (config.ogUrl)
        meta.push({ property: "og:url", content: config.ogUrl });
      if (config.twitterCard)
        meta.push({ name: "twitter:card", content: config.twitterCard });
      if (config.twitterTitle)
        meta.push({ name: "twitter:title", content: config.twitterTitle });
      if (config.twitterDescription)
        meta.push({ name: "twitter:description", content: config.twitterDescription });
      if (config.twitterImage)
        meta.push({ name: "twitter:image", content: config.twitterImage });
      if (config.robots)
        meta.push({ name: "robots", content: config.robots });
      if (config.canonical)
        meta.push({ property: "og:url", content: config.canonical });
      useHead({ title: config.title || config.ogTitle, meta });
    }
    var _toastId = 0;
    var _toastIcons = { success: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>', error: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>', info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>', warning: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' };
    var _toastColors = { success: "#16a34a", error: "#dc2626", info: "#2563eb", warning: "#d97706" };
    function _getToastContainer() {
      return document.getElementById("stx-toast-container");
    }
    function _getToastAnimClass(container) {
      if (!container)
        return { inAnim: "stx-toast-in", outAnim: "stx-toast-out" };
      var pos = container.getAttribute("data-stx-toast-position") || "top-right";
      if (pos.indexOf("left") !== -1)
        return { inAnim: "stx-toast-in-left", outAnim: "stx-toast-out-left" };
      if (pos.indexOf("center") !== -1)
        return { inAnim: "stx-toast-in-center", outAnim: "stx-toast-out-center" };
      return { inAnim: "stx-toast-in", outAnim: "stx-toast-out" };
    }
    function removeToast(id) {
      var el = document.getElementById("stx-toast-" + id);
      if (!el)
        return;
      var container = _getToastContainer();
      var anims = _getToastAnimClass(container);
      el.style.animation = anims.outAnim + " 0.3s ease forwards";
      setTimeout(function() {
        if (el.parentNode)
          el.parentNode.removeChild(el);
      }, 300);
    }
    function _resolveDark(override) {
      if (override != null)
        return !!override;
      var root = document.documentElement;
      if (root.classList.contains("dark"))
        return true;
      var attr = root.getAttribute("data-theme") || root.getAttribute("data-color-mode");
      if (attr === "dark")
        return true;
      if (attr === "light")
        return false;
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    }
    function addToast(type, message, options) {
      var container = _getToastContainer();
      if (!container) {
        console.warn("[stx:toast] No <StxToast /> container found. Add <StxToast /> to your layout.");
        return -1;
      }
      var opts = options || {};
      var duration = opts.duration !== undefined ? opts.duration : 3000;
      var id = ++_toastId;
      var maxToasts = parseInt(container.getAttribute("data-stx-toast-max") || "5", 10);
      var key = opts.id != null ? String(opts.id) : "";
      if (key) {
        var prior = container.querySelector('[data-stx-toast-key="' + key.replace(/"/g, "") + '"]');
        if (prior && prior.parentNode)
          prior.parentNode.removeChild(prior);
      }
      var existing = container.querySelectorAll("[data-stx-toast]");
      while (existing.length >= maxToasts && existing.length > 0) {
        var oldId = existing[0].getAttribute("data-stx-toast");
        removeToast(oldId);
        existing = container.querySelectorAll("[data-stx-toast]");
      }
      var anims = _getToastAnimClass(container);
      var borderColor = _toastColors[type] || _toastColors.info;
      var icon = _toastIcons[type] || _toastIcons.info;
      var isDark = _resolveDark(opts.dark);
      var bg = isDark ? "#1f2937" : "#ffffff";
      var textColor = isDark ? "#f3f4f6" : "#1f2937";
      var shadow = isDark ? "0 4px 12px rgba(0,0,0,0.4)" : "0 4px 12px rgba(0,0,0,0.15)";
      var el = document.createElement("div");
      el.id = "stx-toast-" + id;
      el.setAttribute("data-stx-toast", String(id));
      if (key)
        el.setAttribute("data-stx-toast-key", key);
      el.setAttribute("role", "alert");
      el.setAttribute("aria-live", "assertive");
      el.style.cssText = "pointer-events:auto;display:flex;align-items:flex-start;gap:0.75rem;padding:0.875rem 1rem;border-radius:0.5rem;border-left:4px solid " + borderColor + ";background:" + bg + ";color:" + textColor + ";box-shadow:" + shadow + ";animation:" + anims.inAnim + " 0.3s ease;font-family:system-ui,-apple-system,sans-serif;font-size:0.875rem;line-height:1.4;max-width:100%";
      var iconSpan = document.createElement("span");
      iconSpan.style.cssText = "flex-shrink:0;display:flex;align-items:center;margin-top:1px";
      iconSpan.innerHTML = icon;
      var msgSpan = document.createElement(opts.title ? "div" : "span");
      msgSpan.style.cssText = "flex:1;word-wrap:break-word";
      if (opts.title) {
        var titleEl = document.createElement("div");
        titleEl.setAttribute("data-stx-toast-title", "");
        titleEl.style.cssText = "font-weight:600;margin-bottom:0.125rem";
        titleEl.textContent = opts.title;
        msgSpan.appendChild(titleEl);
        var bodyEl = document.createElement("div");
        bodyEl.style.cssText = "opacity:0.9";
        bodyEl.textContent = message;
        msgSpan.appendChild(bodyEl);
      } else {
        msgSpan.textContent = message;
      }
      var closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.setAttribute("aria-label", "Dismiss notification");
      closeBtn.style.cssText = "flex-shrink:0;background:none;border:none;cursor:pointer;padding:0;color:" + (isDark ? "#9ca3af" : "#6b7280") + ";font-size:1.125rem;line-height:1;display:flex;align-items:center";
      closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z"/></svg>';
      closeBtn.onclick = function() {
        removeToast(id);
      };
      el.appendChild(iconSpan);
      el.appendChild(msgSpan);
      el.appendChild(closeBtn);
      container.appendChild(el);
      if (duration > 0) {
        setTimeout(function() {
          removeToast(id);
        }, duration);
      }
      return id;
    }
    var toast = { success: function(message, options) {
      return addToast("success", message, options);
    }, error: function(message, options) {
      return addToast("error", message, options);
    }, info: function(message, options) {
      return addToast("info", message, options);
    }, warning: function(message, options) {
      return addToast("warning", message, options);
    }, dismiss: function(id) {
      if (id !== undefined) {
        if (typeof id === "string") {
          var c = _getToastContainer();
          var match = c && c.querySelector('[data-stx-toast-key="' + id.replace(/"/g, "") + '"]');
          if (match)
            removeToast(match.getAttribute("data-stx-toast"));
          return;
        }
        removeToast(id);
        return;
      }
      var container = _getToastContainer();
      if (!container)
        return;
      var all = container.querySelectorAll("[data-stx-toast]");
      for (var i = 0;i < all.length; i++) {
        var tid = all[i].getAttribute("data-stx-toast");
        removeToast(tid);
      }
    } };
    var modal = { open: function(id) {
      var el = document.querySelector('[data-stx-modal="' + id + '"]');
      if (!el) {
        console.warn('[stx:modal] Modal "' + id + '" not found');
        return;
      }
      el.style.display = "flex";
      el.offsetHeight;
      el.setAttribute("data-stx-modal-open", "");
      document.body.style.overflow = "hidden";
      if (el.getAttribute("data-close-escape") !== "false") {
        var escHandler = function(e) {
          if (e.key === "Escape") {
            modal.close(id);
            document.removeEventListener("keydown", escHandler);
          }
        };
        document.addEventListener("keydown", escHandler);
        el._stxEscHandler = escHandler;
      }
      if (el.getAttribute("data-close-backdrop") !== "false") {
        el.onclick = function(e) {
          if (e.target === el)
            modal.close(id);
        };
      }
    }, close: function(id) {
      var el = document.querySelector('[data-stx-modal="' + id + '"]');
      if (!el)
        return;
      el.removeAttribute("data-stx-modal-open");
      if (el._stxEscHandler) {
        document.removeEventListener("keydown", el._stxEscHandler);
        el._stxEscHandler = null;
      }
      el.onclick = null;
      setTimeout(function() {
        el.style.display = "none";
        if (!document.querySelector("[data-stx-modal-open]"))
          document.body.style.overflow = "";
      }, 200);
    }, toggle: function(id) {
      var el = document.querySelector('[data-stx-modal="' + id + '"]');
      if (el && el.hasAttribute("data-stx-modal-open"))
        modal.close(id);
      else
        modal.open(id);
    } };
    var _dialogId = 0;
    var _dialogStack = [];
    var _dialogInerted = [];
    var _dialogScrollLock = null;
    function _dialogSyncModality() {
      var top = _dialogStack.length ? _dialogStack[_dialogStack.length - 1] : null;
      for (var i = 0;i < _dialogInerted.length; i++) {
        try {
          _dialogInerted[i].inert = false;
        } catch (_e) {}
      }
      _dialogInerted = [];
      if (!top) {
        if (_dialogScrollLock) {
          document.body.style.overflow = _dialogScrollLock.body;
          document.documentElement.style.overflow = _dialogScrollLock.html;
          document.body.style.paddingRight = _dialogScrollLock.pad;
          _dialogScrollLock = null;
        }
        return;
      }
      if (!_dialogScrollLock) {
        _dialogScrollLock = { body: document.body.style.overflow, html: document.documentElement.style.overflow, pad: document.body.style.paddingRight };
        var gap = window.innerWidth - document.documentElement.clientWidth;
        if (gap > 0) {
          var existing = Number.parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
          document.body.style.paddingRight = existing + gap + "px";
        }
        document.body.style.overflow = "hidden";
        document.documentElement.style.overflow = "hidden";
      }
      var kids = document.body.children;
      for (var k = 0;k < kids.length; k++) {
        var kid = kids[k];
        if (kid === top || kid.inert)
          continue;
        try {
          kid.inert = true;
          _dialogInerted.push(kid);
        } catch (_e) {}
      }
    }
    function _dialogReducedMotion() {
      try {
        return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      } catch (_e) {
        return false;
      }
    }
    var _dialogIcons = { info: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>', warning: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>', error: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>', success: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>', question: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' };
    function _createDialog(message, options, isConfirm) {
      var opts = options || {};
      var type = opts.type || (isConfirm ? "question" : "info");
      var title = opts.title || "";
      var confirmText = opts.confirmText || "OK";
      var cancelText = opts.cancelText || "Cancel";
      var id = "stx-dialog-" + ++_dialogId;
      var isDark = _resolveDark(opts.dark);
      var bg = isDark ? "#1f2937" : "#ffffff";
      var textColor = isDark ? "#f3f4f6" : "#1f2937";
      var subColor = isDark ? "#9ca3af" : "#6b7280";
      var icon = _dialogIcons[type] || _dialogIcons.info;
      return new Promise(function(resolve) {
        var still = _dialogReducedMotion();
        var fade = still ? "" : "transition:opacity 0.2s ease;";
        var scale = still ? "" : "transition:transform 0.2s ease;";
        var backdrop = document.createElement("div");
        backdrop.id = id;
        backdrop.style.cssText = "position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);backdrop-filter:blur(2px);opacity:" + (still ? "1" : "0") + ";" + fade + "font-family:system-ui,-apple-system,sans-serif";
        backdrop.setAttribute("role", "alertdialog");
        backdrop.setAttribute("aria-modal", "true");
        var panel = document.createElement("div");
        panel.style.cssText = "max-width:24rem;width:calc(100% - 2rem);border-radius:0.75rem;padding:1.5rem;background:" + bg + ";color:" + textColor + ";box-shadow:0 20px 60px rgba(0,0,0,0.3);transform:scale(" + (still ? "1" : "0.95") + ");" + scale + "text-align:center";
        var iconDiv = document.createElement("div");
        iconDiv.style.cssText = "display:flex;justify-content:center;margin-bottom:1rem";
        iconDiv.innerHTML = icon;
        panel.appendChild(iconDiv);
        if (title) {
          var titleEl = document.createElement("h3");
          titleEl.id = id + "-title";
          titleEl.style.cssText = "margin:0 0 0.5rem;font-size:1.125rem;font-weight:600";
          titleEl.textContent = title;
          panel.appendChild(titleEl);
          backdrop.setAttribute("aria-labelledby", titleEl.id);
        }
        var msgEl = document.createElement("p");
        msgEl.id = id + "-message";
        msgEl.style.cssText = "margin:0 0 1.25rem;font-size:0.875rem;line-height:1.5;color:" + subColor;
        msgEl.textContent = message;
        panel.appendChild(msgEl);
        backdrop.setAttribute("aria-describedby", msgEl.id);
        if (!title)
          backdrop.setAttribute("aria-label", message);
        var btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;gap:0.75rem;justify-content:center";
        var previouslyFocused = document.activeElement;
        var closed = false;
        function cleanup(result) {
          if (closed)
            return;
          closed = true;
          document.removeEventListener("keydown", keyHandler, true);
          var at = _dialogStack.indexOf(backdrop);
          if (at !== -1)
            _dialogStack.splice(at, 1);
          backdrop.style.pointerEvents = "none";
          backdrop.style.opacity = "0";
          if (!still)
            panel.style.transform = "scale(0.95)";
          setTimeout(function() {
            backdrop.remove();
          }, still ? 0 : 200);
          _dialogSyncModality();
          if (previouslyFocused && typeof previouslyFocused.focus === "function") {
            try {
              previouslyFocused.focus();
            } catch (_e) {}
          }
          resolve(result);
        }
        var cancelBtn = null;
        if (isConfirm) {
          cancelBtn = document.createElement("button");
          cancelBtn.textContent = cancelText;
          cancelBtn.style.cssText = "padding:0.5rem 1.25rem;border-radius:0.5rem;font-size:0.875rem;font-weight:500;cursor:pointer;border:1px solid " + (isDark ? "#374151" : "#d1d5db") + ";background:transparent;color:" + textColor + ";transition:background 0.15s";
          cancelBtn.onmouseover = function() {
            this.style.background = isDark ? "#374151" : "#f3f4f6";
          };
          cancelBtn.onmouseout = function() {
            this.style.background = "transparent";
          };
          cancelBtn.onclick = function() {
            cleanup(false);
          };
          btnRow.appendChild(cancelBtn);
        }
        var okBtn = document.createElement("button");
        okBtn.textContent = confirmText;
        var btnColor = type === "error" ? "#dc2626" : type === "warning" ? "#d97706" : "#5672cd";
        okBtn.style.cssText = "padding:0.5rem 1.25rem;border-radius:0.5rem;font-size:0.875rem;font-weight:500;cursor:pointer;border:none;background:" + btnColor + ";color:#fff;transition:opacity 0.15s";
        okBtn.onmouseover = function() {
          this.style.opacity = "0.9";
        };
        okBtn.onmouseout = function() {
          this.style.opacity = "1";
        };
        okBtn.onclick = function() {
          cleanup(isConfirm ? true : undefined);
        };
        btnRow.appendChild(okBtn);
        panel.appendChild(btnRow);
        backdrop.appendChild(panel);
        document.body.appendChild(backdrop);
        _dialogStack.push(backdrop);
        _dialogSyncModality();
        if (!still) {
          backdrop.offsetHeight;
          backdrop.style.opacity = "1";
          panel.style.transform = "scale(1)";
        }
        var keyHandler = function(e) {
          if (_dialogStack.length && _dialogStack[_dialogStack.length - 1] !== backdrop)
            return;
          if (e.key === "Escape") {
            e.preventDefault();
            cleanup(isConfirm ? false : undefined);
            return;
          }
          if (e.key !== "Tab")
            return;
          var focusable = panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
          if (!focusable.length)
            return;
          var first = focusable[0];
          var last = focusable[focusable.length - 1];
          if (!panel.contains(document.activeElement)) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
            return;
          }
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        };
        document.addEventListener("keydown", keyHandler, true);
        var focusTarget = okBtn;
        if (isConfirm && cancelBtn) {
          var want = opts.defaultFocus;
          if (want === "cancel" || !want && type === "error")
            focusTarget = cancelBtn;
          else if (want === "confirm")
            focusTarget = okBtn;
        }
        focusTarget.focus();
      });
    }
    function stxAlert(message, options) {
      return _createDialog(message, options, false);
    }
    function stxConfirm(message, options) {
      return _createDialog(message, options, true);
    }
    var drawer = { open: function(id) {
      var el = document.querySelector('[data-stx-drawer="' + id + '"]');
      if (!el) {
        console.warn('[stx:drawer] Drawer "' + id + '" not found');
        return;
      }
      el.style.display = "flex";
      el.offsetHeight;
      el.setAttribute("data-stx-drawer-open", "");
      document.body.style.overflow = "hidden";
      if (el.getAttribute("data-close-escape") !== "false") {
        var escHandler = function(e) {
          if (e.key === "Escape") {
            drawer.close(id);
            document.removeEventListener("keydown", escHandler);
          }
        };
        document.addEventListener("keydown", escHandler);
        el._stxEscHandler = escHandler;
      }
      if (el.getAttribute("data-close-backdrop") !== "false") {
        el.onclick = function(e) {
          if (e.target === el)
            drawer.close(id);
        };
      }
    }, close: function(id) {
      var el = document.querySelector('[data-stx-drawer="' + id + '"]');
      if (!el)
        return;
      el.removeAttribute("data-stx-drawer-open");
      if (el._stxEscHandler) {
        document.removeEventListener("keydown", el._stxEscHandler);
        el._stxEscHandler = null;
      }
      el.onclick = null;
      setTimeout(function() {
        el.style.display = "none";
        if (!document.querySelector("[data-stx-drawer-open]") && !document.querySelector("[data-stx-modal-open]"))
          document.body.style.overflow = "";
      }, 300);
    }, toggle: function(id) {
      var el = document.querySelector('[data-stx-drawer="' + id + '"]');
      if (el && el.hasAttribute("data-stx-drawer-open"))
        drawer.close(id);
      else
        drawer.open(id);
    } };
    (function() {
      var tip = null;
      function createTip() {
        tip = document.createElement("div");
        tip.id = "stx-tooltip";
        tip.style.cssText = "position:absolute;z-index:999999;pointer-events:none;background:#1f2937;color:#fff;font-size:12px;line-height:1.4;padding:6px 10px;border-radius:6px;max-width:250px;word-wrap:break-word;opacity:0;transition:opacity 0.15s ease;white-space:pre-wrap;box-shadow:0 2px 8px rgba(0,0,0,0.2)";
        document.body.appendChild(tip);
      }
      function show(el) {
        if (!tip)
          createTip();
        var text = el.getAttribute("x-tooltip");
        if (!text)
          return;
        tip.textContent = text;
        tip.style.display = "block";
        tip.style.opacity = "0";
        var pos = el.getAttribute("x-tooltip-position") || "top";
        var rect = el.getBoundingClientRect();
        var tw = tip.offsetWidth;
        var th = tip.offsetHeight;
        var sx = window.scrollX;
        var sy = window.scrollY;
        var left, top;
        if (pos === "bottom") {
          left = rect.left + rect.width / 2 - tw / 2;
          top = rect.bottom + 8;
        } else if (pos === "left") {
          left = rect.left - tw - 8;
          top = rect.top + rect.height / 2 - th / 2;
        } else if (pos === "right") {
          left = rect.right + 8;
          top = rect.top + rect.height / 2 - th / 2;
        } else {
          left = rect.left + rect.width / 2 - tw / 2;
          top = rect.top - th - 8;
          if (top < 0) {
            top = rect.bottom + 8;
          }
        }
        if (left < 4)
          left = 4;
        if (left + tw > window.innerWidth - 4)
          left = window.innerWidth - tw - 4;
        tip.style.left = left + sx + "px";
        tip.style.top = top + sy + "px";
        tip.style.opacity = "1";
      }
      function hide() {
        if (tip) {
          tip.style.opacity = "0";
          setTimeout(function() {
            if (tip)
              tip.style.display = "none";
          }, 150);
        }
      }
      document.addEventListener("mouseover", function(e) {
        var el = e.target.closest("[x-tooltip]");
        if (el)
          show(el);
      });
      document.addEventListener("mouseout", function(e) {
        var el = e.target.closest("[x-tooltip]");
        if (el)
          hide();
      });
      document.addEventListener("focusin", function(e) {
        var el = e.target.closest("[x-tooltip]");
        if (el)
          show(el);
      });
      document.addEventListener("focusout", function(e) {
        var el = e.target.closest("[x-tooltip]");
        if (el)
          hide();
      });
    })();
    function hydrateSubtree(container) {
      if (!container || !container.querySelectorAll)
        return;
      var scoped = container.querySelectorAll("script[data-stx-scoped]");
      for (var i = 0;i < scoped.length; i++) {
        var old = scoped[i];
        if (old.__stx_ran)
          continue;
        var fresh = document.createElement("script");
        for (var a = 0;a < old.attributes.length; a++)
          fresh.setAttribute(old.attributes[a].name, old.attributes[a].value);
        fresh.textContent = old.textContent;
        fresh.__stx_ran = true;
        if (old.parentNode)
          old.parentNode.replaceChild(fresh, old);
      }
      var scopeEls = [];
      if (container.matches && container.matches("[data-stx-scope]"))
        scopeEls.push(container);
      container.querySelectorAll("[data-stx-scope]").forEach(function(el) {
        scopeEls.push(el);
      });
      scopeEls.forEach(function(el) {
        if (el.__stx_disposers)
          return;
        var scopeId = el.getAttribute("data-stx-scope");
        var scopeVars = window.stx._scopes && window.stx._scopes[scopeId];
        if (!scopeVars)
          return;
        el.__stx_parent_scope = el.__stx_parent_scope || resolveComponentCallerScope(el, componentScope);
        bindParentComponentProps(el, el.__stx_parent_scope);
        Object.assign(componentScope, scopeVars);
        el.__stx_disposers = trackEffects(function() {
          processElement(el, componentScope);
        });
        if (scopeVars.__mountCallbacks && !scopeVars.__mounted) {
          scopeVars.__mounted = true;
          runMountCallbacks(scopeVars.__mountCallbacks, scopeDestroySink(scopeVars));
        }
      });
      processElement(container);
      if (container.removeAttribute)
        container.removeAttribute("x-cloak");
      container.querySelectorAll("[x-cloak]").forEach(function(c) {
        c.removeAttribute("x-cloak");
      });
      if (mountCallbacks.length) {
        var cbs = mountCallbacks.slice();
        mountCallbacks.length = 0;
        runMountCallbacks(cbs, destroyCallbacks);
      }
      window.dispatchEvent(new CustomEvent("stx:hydrated", { detail: { el: container, trigger: "stream" } }));
    }
    var mountQueue = [];
    window.stx = Object.assign(window.stx || {}, { hydrate: hydrateSubtree, hydrateHost, state, derived, effect, batch, isSignal, isDerived, untrack, peek, inject, watchMultiple, onMount, onBeforeMount: onMount, onDestroy, onMounted: onMount, onBeforeUnmount: onDestroy, onUnmounted: onDestroy, useFetch, clearServerData, useRef, navigate, refresh, invalidateRoute, goBack, goForward, useRoute, useRouteParams, useRouteParam, setRouteParams, useSearchParams, useQuery, useMutation, configureFetch, useOptimistic, provide, $computed, $watch, ref, reactive, computed, watch, watchEffect, useDebounce, useDebouncedValue, useThrottle, useInterval, useTimeout, useToggle, useCounter, useClickOutside, useFocus, nextTick, useAsync, useLocalStorage, useSessionStorage, keptState, forgetKeptState, setKeptScope, flushKeptState, cachedQuery, useCookie, useId, useReactiveProp, useModel, useEventListener, useWebSocket, useColorMode, useDark, useMediaQuery, useDocumentVisibility, useScrollLock, usePreferredDark, usePreferredLight, usePreferredReducedMotion, usePreferredContrast, useHead, useSeoMeta, definePageMeta: function() {}, toast, modal, drawer, alert: stxAlert, confirm: stxConfirm, helpers: globalHelpers, defineProps: function(definitions) {
      var props = window.__STX_CURRENT_PROPS__ || {};
      if (!definitions)
        return props;
      var result = Object.assign({}, props);
      for (var key in definitions) {
        if (!definitions.hasOwnProperty(key))
          continue;
        var def = definitions[key];
        var opts = typeof def === "function" || Array.isArray(def) ? { type: def } : def || {};
        if (result[key] === undefined && opts["default"] !== undefined) {
          result[key] = typeof opts["default"] === "function" ? opts["default"]() : opts["default"];
        }
      }
      return result;
    }, withDefaults: function(props, defaults) {
      var result = Object.assign({}, props);
      for (var key in defaults) {
        if (!defaults.hasOwnProperty(key))
          continue;
        if (result[key] === undefined) {
          result[key] = typeof defaults[key] === "function" ? defaults[key]() : defaults[key];
        }
      }
      return result;
    }, defineEmits: function(events) {
      var el = window.__STX_CURRENT_ELEMENT__ || null;
      var declaredEvents = Array.isArray(events) ? events : events && typeof events === "object" ? Object.keys(events) : [];
      if (el && declaredEvents.length) {
        el.__stx_component_emits = el.__stx_component_emits || Object.create(null);
        declaredEvents.forEach(function(event) {
          el.__stx_component_emits[event] = true;
        });
      }
      return function(event, payload) {
        var target = el || document.body;
        if (el) {
          el.__stx_component_emits = el.__stx_component_emits || Object.create(null);
          el.__stx_component_emits[event] = true;
        }
        target.dispatchEvent(new CustomEvent(event, { detail: payload, bubbles: true, cancelable: true }));
      };
    }, defineExpose: function(exposed) {
      var el = window.__STX_CURRENT_ELEMENT__;
      if (el)
        el.__stx_exposed = exposed;
    }, defineSlots: function() {
      return window.__STX_CURRENT_SLOTS__ || {};
    }, useSlots: function() {
      return window.__STX_CURRENT_SLOTS__ || {};
    }, _mountCallbacks: mountCallbacks, _destroyCallbacks: destroyCallbacks, _cleanupContainer: cleanupContainer, _flushLoad: flushStxLoad, _registerSuspense: registerSuspense, _tg: { enter: tgEnter, leave: tgLeave, flip: tgFlip, snapshot: tgSnapshot }, _scopes: {}, _scopeCounter: 0, _latestSetup: window.__stx_latestSetup || null, _stores: new Map, defineStore: function(id, setupOrOptions, storeOptions) {
      if (window.stx._stores.has(id) && !window.stx.__hmrStoreReplacing) {
        return window.stx._stores.get(id);
      }
      var setupFn;
      if (typeof setupOrOptions === "function") {
        setupFn = setupOrOptions;
      } else {
        var opts = setupOrOptions;
        setupFn = function() {
          var result = {};
          var initialState = typeof opts.state === "function" ? opts.state() : opts.state || {};
          var stateSignals = {};
          for (var key in initialState) {
            stateSignals[key] = state(initialState[key]);
            result[key] = stateSignals[key];
          }
          if (opts.getters) {
            for (var gKey in opts.getters) {
              (function(getterKey, getterFn) {
                result[getterKey] = derived(function() {
                  var snapshot = {};
                  for (var sk in stateSignals) {
                    snapshot[sk] = stateSignals[sk]();
                  }
                  return getterFn(snapshot);
                });
              })(gKey, opts.getters[gKey]);
            }
          }
          var mutatingArrayMethods = { push: 1, pop: 1, shift: 1, unshift: 1, splice: 1, sort: 1, reverse: 1, fill: 1, copyWithin: 1 };
          var viewRaw = new WeakMap;
          var viewCache = new WeakMap;
          var unwrapView = function(v) {
            return v && typeof v === "object" && viewRaw.has(v) ? viewRaw.get(v) : v;
          };
          var isPlainContainer = function(v) {
            if (!v || typeof v !== "object")
              return false;
            if (Array.isArray(v))
              return true;
            var proto = Object.getPrototypeOf(v);
            return proto === Object.prototype || proto === null;
          };
          var mutableView = function(sig, raw) {
            var cached = viewCache.get(raw);
            if (cached && cached.sig === sig)
              return cached.view;
            var view = new Proxy(raw, { get: function(target, p) {
              if (Array.isArray(target) && typeof p === "string" && mutatingArrayMethods[p]) {
                return function() {
                  var args = Array.prototype.map.call(arguments, unwrapView);
                  var out = Array.prototype[p].apply(target, args);
                  sig.trigger();
                  return out === target ? view : out;
                };
              }
              return Reflect.get(target, p, target);
            }, set: function(target, p, v) {
              target[p] = unwrapView(v);
              sig.trigger();
              return true;
            }, deleteProperty: function(target, p) {
              var had = Object.prototype.hasOwnProperty.call(target, p);
              delete target[p];
              if (had)
                sig.trigger();
              return true;
            } });
            viewRaw.set(view, raw);
            viewCache.set(raw, { sig, view });
            return view;
          };
          if (opts.actions) {
            for (var aKey in opts.actions) {
              (function(actionKey, actionFn) {
                result[actionKey] = function() {
                  var proxy = new Proxy({}, { get: function(_, p) {
                    if (result[p] && result[p]._isSignal) {
                      var current = result[p]();
                      return typeof result[p].trigger === "function" && isPlainContainer(current) ? mutableView(result[p], current) : current;
                    }
                    if (result[p])
                      return result[p];
                    return;
                  }, set: function(_, p, v) {
                    if (result[p] && result[p]._isSignal) {
                      result[p].set(unwrapView(v));
                      return true;
                    }
                    return false;
                  } });
                  return actionFn.apply(proxy, arguments);
                };
              })(aKey, opts.actions[aKey]);
            }
          }
          return result;
        };
      }
      var prevDisposers = activeDisposers;
      activeDisposers = null;
      var result;
      try {
        result = setupFn();
      } finally {
        activeDisposers = prevDisposers;
      }
      var signalKeys = [];
      var actionKeys = [];
      for (var dk in result) {
        if (result[dk] && result[dk]._isSignal)
          signalKeys.push(dk);
        else if (typeof result[dk] === "function")
          actionKeys.push(dk);
      }
      var _initialValues = {};
      for (var k in result) {
        if (result[k] && result[k]._isSignal) {
          _initialValues[k] = result[k]();
        }
      }
      result.$id = id;
      result.$reset = function() {
        batch(function() {
          for (var rk in _initialValues) {
            if (result[rk] && result[rk]._isSignal)
              result[rk].set(_initialValues[rk]);
          }
        });
      };
      result.$patch = function(partial) {
        batch(function() {
          for (var pk in partial) {
            if (result[pk] && result[pk]._isSignal)
              result[pk].set(partial[pk]);
          }
        });
      };
      result.$subscribe = function(cb) {
        var unsubs = [];
        for (var sk in result) {
          if (result[sk] && result[sk]._isSignal && result[sk].subscribe) {
            unsubs.push(result[sk].subscribe(function() {
              var snapshot = {};
              for (var ssk in result) {
                if (result[ssk] && result[ssk]._isSignal)
                  snapshot[ssk] = result[ssk]();
              }
              cb(snapshot);
            }));
          }
        }
        return function() {
          unsubs.forEach(function(u) {
            u();
          });
        };
      };
      result.$dispose = function() {
        window.stx._stores.delete(id);
        if (window.__STX_STORES__)
          delete window.__STX_STORES__[id];
      };
      var hydrationData = window.__STX_STORE_STATE__ && window.__STX_STORE_STATE__[id];
      if (hydrationData) {
        batch(function() {
          for (var hk in hydrationData) {
            if (result[hk] && result[hk]._isSignal)
              result[hk].set(hydrationData[hk]);
          }
        });
      }
      var persistCfg = storeOptions && storeOptions.persist;
      if (persistCfg) {
        let _backendFor = function(kind) {
          if (kind === "cookie")
            return "cookie";
          var scope = typeof window !== "undefined" ? window : null;
          if (kind === "session" || kind === "sessionStorage")
            return typeof sessionStorage !== "undefined" ? sessionStorage : scope && scope.sessionStorage;
          return typeof localStorage !== "undefined" ? localStorage : scope && scope.localStorage;
        }, _mappedConfig = function(field) {
          if (!fieldMap || !Object.prototype.hasOwnProperty.call(fieldMap, field))
            return null;
          var cfg = fieldMap[field];
          if (typeof cfg === "string")
            cfg = { key: cfg };
          cfg = cfg || {};
          return { key: cfg.key || field, backend: _backendFor(cfg.storage === undefined ? pOpts.storage : cfg.storage), cookieOpts: cfg, serialize: cfg.serialize || defaultSerialize, deserialize: cfg.deserialize || defaultDeserialize };
        }, _inBlob = function(field) {
          if (pick && pick.indexOf(field) === -1)
            return false;
          return !_mappedConfig(field);
        };
        var pOpts = persistCfg === true ? {} : persistCfg;
        var storageKey = pOpts.key || "stx-store-" + id;
        var pick = pOpts.pick || null;
        var fieldMap = pOpts.keys || null;
        var defaultSerialize = pOpts.serialize || function(value) {
          return JSON.stringify(value);
        };
        var defaultDeserialize = pOpts.deserialize || function(raw) {
          return JSON.parse(raw);
        };
        var storageType = _backendFor(pOpts.storage);
        try {
          var saved = storageType === "cookie" ? null : storageType.getItem(storageKey);
          if (saved) {
            var parsed = defaultDeserialize(saved);
            batch(function() {
              for (var pk in parsed) {
                if (result[pk] && result[pk]._isSignal && _inBlob(pk)) {
                  result[pk].set(parsed[pk]);
                }
              }
            });
          }
        } catch (e) {
          console.warn("[stx:store] persistence read error:", id, e);
        }
        var prevFieldDisposers = activeDisposers;
        activeDisposers = null;
        if (fieldMap) {
          for (var fk in fieldMap) {
            if (!Object.prototype.hasOwnProperty.call(fieldMap, fk))
              continue;
            if (!result[fk] || !result[fk]._isSignal) {
              console.warn("[stx:store] persist.keys names a field that is not a signal:", id, fk);
              continue;
            }
            (function(field, cfg, signal) {
              if (cfg.backend === "cookie") {
                var cookieSignal = useCookie(cfg.key, cfg.cookieOpts);
                var initialCookie = cookieSignal();
                if (initialCookie !== "" && initialCookie != null) {
                  try {
                    signal.set(cfg.deserialize(initialCookie));
                  } catch (e) {
                    console.warn("[stx:store] persist read error:", id, field, e);
                  }
                }
                effect(function() {
                  var next = signal();
                  try {
                    cookieSignal.set(next == null ? "" : String(cfg.serialize(next)));
                  } catch (e) {
                    console.warn("[stx:store] persist write error:", id, field, e);
                  }
                });
                return;
              }
              try {
                var rawValue = cfg.backend.getItem(cfg.key);
                if (rawValue !== null)
                  signal.set(cfg.deserialize(rawValue));
              } catch (e) {
                console.warn("[stx:store] persist read error:", id, field, e);
              }
              effect(function() {
                var value = signal();
                try {
                  cfg.backend.setItem(cfg.key, String(cfg.serialize(value)));
                } catch (e) {
                  console.warn("[stx:store] persist write error:", id, field, e);
                }
              });
            })(fk, _mappedConfig(fk), result[fk]);
          }
        }
        activeDisposers = prevFieldDisposers;
        var writeTimer = null;
        var prevPersistDisposers = activeDisposers;
        activeDisposers = null;
        effect(function() {
          var snapshot = {};
          var wrote = false;
          for (var wk in result) {
            if (result[wk] && result[wk]._isSignal && _inBlob(wk)) {
              snapshot[wk] = result[wk]();
              wrote = true;
            }
          }
          if (!wrote || storageType === "cookie")
            return;
          if (writeTimer)
            clearTimeout(writeTimer);
          writeTimer = setTimeout(function() {
            try {
              storageType.setItem(storageKey, String(defaultSerialize(snapshot)));
            } catch (e) {
              console.warn("[stx:store] persist write error:", id, e);
            }
          }, 100);
        });
        activeDisposers = prevPersistDisposers;
      }
      result._isStxStore = true;
      var seed = window.stx.__hmrStoreSeed && window.stx.__hmrStoreSeed[id];
      if (seed) {
        for (var seedKey in seed) {
          var target = result[seedKey];
          if (target && target._isSignal && typeof target.set === "function" && !target._isDerived) {
            try {
              target.set(seed[seedKey]);
            } catch (e) {}
          }
        }
      }
      window.stx._stores.set(id, result);
      window.__STX_STORES__ = window.__STX_STORES__ || {};
      window.__STX_STORES__[id] = result;
      return result;
    }, __hmrReplaceStores: function(code) {
      var seed = {};
      window.stx._stores.forEach(function(store, id) {
        var values = {};
        for (var key in store) {
          var value = store[key];
          if (value && value._isSignal && !value._isDerived) {
            try {
              values[key] = value.peek ? value.peek() : value();
            } catch (e) {}
          }
        }
        seed[id] = values;
      });
      window.stx.__hmrStoreSeed = seed;
      window.stx.__hmrStoreReplacing = true;
      var ok = true;
      try {
        (0, eval)(code);
      } catch (e) {
        ok = false;
        console.error("[stx:hmr] store bundle failed to evaluate:", e);
      } finally {
        window.stx.__hmrStoreReplacing = false;
        window.stx.__hmrStoreSeed = null;
      }
      if (!ok)
        return false;
      if (window.stxRouter && typeof window.stxRouter.refresh === "function") {
        try {
          window.stxRouter.refresh();
        } catch (e) {}
      }
      return true;
    }, registerStoresClient: function(stores) {
      window.__STX_STORES__ = window.__STX_STORES__ || {};
      var names = Object.keys(stores || {});
      for (var i = 0;i < names.length; i++) {
        var name = names[i];
        window.__STX_STORES__[name] = stores[name];
      }
      window.dispatchEvent(new CustomEvent("stx:stores-ready", { detail: names }));
    }, useStore: function(id) {
      var store = window.stx._stores.get(id);
      if (!store && window.__STX_STORES__) {
        store = window.__STX_STORES__[id];
      }
      if (!store) {
        console.error("[stx:store] Store not found:", id, "available:", Array.from(window.stx._stores.keys()));
        throw new Error('[stx] Store "' + id + '" not found. Define it with defineStore() first.');
      }
      return store;
    }, mountEl: function(selector, setupFn) {
      function doMount() {
        var root = document.querySelector(selector);
        if (!root) {
          console.warn("[stx] mountEl: element not found:", selector);
          return;
        }
        var prevProps = window.__STX_CURRENT_PROPS__;
        var prevEl = window.__STX_CURRENT_ELEMENT__;
        var propsAttr = root.getAttribute && root.getAttribute("data-stx-props");
        window.__STX_CURRENT_PROPS__ = root.__stx_props || (propsAttr ? JSON.parse(propsAttr) : {});
        window.__STX_CURRENT_ELEMENT__ = root;
        var mountStart = mountCallbacks.length;
        var destroyStart = destroyCallbacks.length;
        var outerSink = activeDestroySink;
        activeDestroySink = null;
        var scope;
        try {
          scope = setupFn();
        } finally {
          activeDestroySink = outerSink;
        }
        window.__STX_CURRENT_PROPS__ = prevProps;
        window.__STX_CURRENT_ELEMENT__ = prevEl;
        var localMountHooks = mountCallbacks.splice(mountStart);
        var localDestroyHooks = destroyCallbacks.splice(destroyStart);
        if (typeof scope === "object" && scope !== null) {
          scope.$el = root;
          scope.$refs = scope.$refs || {};
          root.__stx_scope = scope;
        }
        var disposeEffects = trackEffects(function() {
          processElement(root, { ...componentScope, ...scope || {} });
        });
        root.__stx_disposers = disposeEffects;
        root.removeAttribute("x-cloak");
        root.querySelectorAll("[x-cloak]").forEach(function(el) {
          el.removeAttribute("x-cloak");
        });
        runMountCallbacks(localMountHooks, localDestroyHooks);
        root.__stx_destroy = localDestroyHooks;
      }
      if (document.readyState === "loading") {
        mountQueue.push(doMount);
      } else {
        doMount();
      }
    }, mount: function(setupFn) {
      var scriptEl = document.currentScript;
      function doMount() {
        var isSpaPageScript = scriptEl && scriptEl.hasAttribute && scriptEl.hasAttribute("data-stx-page") && !scriptEl.hasAttribute("data-stx-positioned");
        var root = null;
        if (scriptEl && !isSpaPageScript) {
          var previous = scriptEl.previousElementSibling;
          while (previous && (previous.tagName === "SCRIPT" || previous.tagName === "STYLE"))
            previous = previous.previousElementSibling;
          var next = scriptEl.nextElementSibling;
          while (next && (next.tagName === "SCRIPT" || next.tagName === "STYLE"))
            next = next.nextElementSibling;
          root = previous || next || scriptEl.parentElement;
        }
        function awaitingReactiveInit(el) {
          if (!el || !el.hasAttribute || !el.hasAttribute("data-stx-xdata"))
            return false;
          var id = el.getAttribute("data-stx-scope");
          return !(id && window.stx && window.stx._scopes && window.stx._scopes[id]);
        }
        var needsFallback = !root || root === document.body || root && root.tagName === "SCRIPT" || awaitingReactiveInit(root);
        if (needsFallback) {
          var routerOpts = window.STX_ROUTER_OPTIONS || window.__stxRouterConfig || {};
          var container = document.querySelector("[data-stx-content]") || document.querySelector("[data-stx-router-container]") || (routerOpts.container ? document.querySelector(routerOpts.container) : null) || document.querySelector("main") || document.querySelector("#content");
          if (container) {
            root = container;
            var hasMount = false;
            var children = container.children;
            for (var ci = 0;ci < children.length; ci++) {
              if (children[ci].__stx_scope) {
                hasMount = true;
                break;
              }
            }
            if (hasMount)
              for (var ci = 0;ci < children.length; ci++) {
                var candidate = children[ci];
                if (candidate.__stx_scope || candidate.tagName === "SCRIPT")
                  continue;
                if (awaitingReactiveInit(candidate))
                  continue;
                root = candidate;
                break;
              }
          }
        }
        if (awaitingReactiveInit(root)) {
          var reactiveOwnerParent = root.parentElement;
          root = reactiveOwnerParent && reactiveOwnerParent !== document.body ? reactiveOwnerParent : null;
        }
        if (!root) {
          console.warn("[stx] mount: no root element found");
          return;
        }
        var prevProps = window.__STX_CURRENT_PROPS__;
        var prevEl = window.__STX_CURRENT_ELEMENT__;
        var propsAttr = root.getAttribute && root.getAttribute("data-stx-props");
        window.__STX_CURRENT_PROPS__ = root.__stx_props || (propsAttr ? JSON.parse(propsAttr) : {});
        window.__STX_CURRENT_ELEMENT__ = root;
        var mountStart = mountCallbacks.length;
        var destroyStart = destroyCallbacks.length;
        var outerSink = activeDestroySink;
        activeDestroySink = null;
        var scope;
        try {
          scope = setupFn();
        } finally {
          activeDestroySink = outerSink;
        }
        window.__STX_CURRENT_PROPS__ = prevProps;
        window.__STX_CURRENT_ELEMENT__ = prevEl;
        var localMountHooks = mountCallbacks.splice(mountStart);
        var localDestroyHooks = destroyCallbacks.splice(destroyStart);
        if (typeof scope === "object" && scope !== null) {
          scope.$el = root;
          scope.$refs = scope.$refs || {};
          root.__stx_scope = scope;
          Object.assign(componentScope, scope);
        }
        var disposeEffects = trackEffects(function() {
          processElement(root, { ...componentScope, ...scope || {} });
        });
        root.__stx_disposers = disposeEffects;
        root.removeAttribute("x-cloak");
        root.querySelectorAll("[x-cloak]").forEach(function(el) {
          el.removeAttribute("x-cloak");
        });
        runMountCallbacks(localMountHooks, localDestroyHooks);
        root.__stx_destroy = localDestroyHooks;
      }
      var isRoutedMount = scriptEl && scriptEl.hasAttribute && scriptEl.hasAttribute("data-stx-page");
      if (document.readyState === "loading" || isRoutedMount) {
        mountQueue.push(doMount);
      } else {
        doMount();
      }
    } });
    window.state = state;
    window.derived = derived;
    window.effect = effect;
    window.batch = batch;
    window.onMount = onMount;
    window.onDestroy = onDestroy;
    window.useFetch = useFetch;
    window.clearServerData = clearServerData;
    window.useRef = useRef;
    window.navigate = navigate;
    window.goBack = goBack;
    window.goForward = goForward;
    window.useRoute = useRoute;
    window.useSearchParams = useSearchParams;
    window.useQuery = useQuery;
    window.useMutation = useMutation;
    window.provide = provide;
    window.$computed = $computed;
    window.$watch = $watch;
    window.useDebounce = useDebounce;
    window.useDebouncedValue = useDebouncedValue;
    window.useThrottle = useThrottle;
    window.useInterval = useInterval;
    window.useTimeout = useTimeout;
    window.useToggle = useToggle;
    window.useCounter = useCounter;
    window.useClickOutside = useClickOutside;
    window.useFocus = useFocus;
    window.nextTick = nextTick;
    window.useAsync = useAsync;
    window.useLocalStorage = useLocalStorage;
    window.useSessionStorage = useSessionStorage;
    window.keptState = keptState;
    window.forgetKeptState = forgetKeptState;
    window.setKeptScope = setKeptScope;
    window.flushKeptState = flushKeptState;
    window.cachedQuery = cachedQuery;
    window.useEventListener = useEventListener;
    window.useWebSocket = useWebSocket;
    window.useColorMode = useColorMode;
    window.useDark = useDark;
    window.useHead = useHead;
    window.useSeoMeta = useSeoMeta;
    window.toast = toast;
    window.modal = modal;
    window.drawer = drawer;
    window.stxAlert = stxAlert;
    window.stxConfirm = stxConfirm;
    window.defineStore = window.stx.defineStore;
    window.useStore = window.stx.useStore;
    window.ref = state;
    window.reactive = reactive;
    window.computed = derived;
    window.watch = $watch;
    window.watchEffect = function(fn) {
      return effect(fn);
    };
    function __stxDevtoolsClassify(sv) {
      var out = { signals: {}, derived: {}, stores: {}, values: {}, methods: [] };
      if (!sv || typeof sv !== "object")
        return out;
      Object.keys(sv).forEach(function(k) {
        if (k.indexOf("__") === 0 || k === "$el" || k === "$refs" || k === "$props")
          return;
        var v = sv[k];
        try {
          if (typeof v === "function" && v._isSignal)
            out.signals[k] = peek(function() {
              return v();
            });
          else if (typeof v === "function" && v._isDerived)
            out.derived[k] = peek(function() {
              return v();
            });
          else if (v && v._isStxStore)
            out.stores[k] = "[store]";
          else if (typeof v === "function")
            out.methods.push(k);
          else
            out.values[k] = v;
        } catch (e) {
          out.values[k] = "[unreadable]";
        }
      });
      return out;
    }
    window.__stxDevtools = { version: 4, enable: function() {
      __stxDevtoolsTracking = true;
    }, disable: function() {
      __stxDevtoolsTracking = false;
    }, tracking: function() {
      return __stxDevtoolsTracking;
    }, stats: function() {
      return { signalSets: __stxDevtoolsStats.signalSets, effectRuns: __stxDevtoolsStats.effectRuns, tracking: __stxDevtoolsTracking };
    }, resetStats: function() {
      __stxDevtoolsStats.signalSets = 0;
      __stxDevtoolsStats.effectRuns = 0;
      __stxDevtoolsIfTrace.length = 0;
      __stxDevtoolsQueries.length = 0;
      __stxDevtoolsMutations.length = 0;
    }, ifTrace: function() {
      return __stxDevtoolsIfTrace.slice();
    }, queries: function() {
      return __stxDevtoolsQueries.slice();
    }, mutations: function() {
      var nameById = {};
      function index(container, label) {
        if (!container || typeof container !== "object")
          return;
        Object.keys(container).forEach(function(k) {
          if (k.indexOf("__") === 0)
            return;
          var v = container[k];
          if (typeof v === "function" && v._stxSignalId)
            nameById[v._stxSignalId] = { name: k, scope: label };
        });
      }
      var scopes = window.stx && window.stx._scopes || {};
      Object.keys(scopes).forEach(function(id) {
        index(scopes[id], id);
      });
      if (window.stx && window.stx._stores && typeof window.stx._stores.forEach === "function")
        window.stx._stores.forEach(function(s, id) {
          index(s, "store:" + id);
        });
      return __stxDevtoolsMutations.map(function(m) {
        var info = nameById[m.sid];
        return { name: info ? info.name : "(anonymous)", scope: info ? info.scope : null, prev: m.prev, next: m.next };
      });
    }, graph: function() {
      var out = [];
      var scopes = window.stx && window.stx._scopes || {};
      Object.keys(scopes).forEach(function(scopeId) {
        var sv = scopes[scopeId];
        if (!sv || typeof sv !== "object")
          return;
        var nodes = [];
        Object.keys(sv).forEach(function(k) {
          if (k.indexOf("__") === 0 || k === "$el" || k === "$refs" || k === "$props")
            return;
          var v = sv[k];
          if (typeof v === "function" && (v._isSignal || v._isDerived)) {
            nodes.push({ name: k, type: v._isDerived ? "derived" : "signal", value: peek(function() {
              return v();
            }), setCount: v._setCount || 0, subscribers: v._effects && typeof v._effects.size === "number" ? v._effects.size : 0 });
          }
        });
        if (nodes.length)
          out.push({ scopeId, nodes });
      });
      return out;
    }, tree: function() {
      var byEl = new Map;
      var roots = [];
      var nodes = document.querySelectorAll("[data-stx-scope]");
      Array.prototype.forEach.call(nodes, function(el) {
        byEl.set(el, { scopeId: el.getAttribute("data-stx-scope"), tag: (el.tagName || "").toLowerCase(), children: [], el });
      });
      Array.prototype.forEach.call(nodes, function(el) {
        var node = byEl.get(el);
        var p = el.parentElement;
        while (p && !byEl.has(p))
          p = p.parentElement;
        if (p)
          byEl.get(p).children.push(node);
        else
          roots.push(node);
      });
      function clean(n) {
        return { scopeId: n.scopeId, tag: n.tag, children: n.children.map(clean) };
      }
      return roots.map(clean);
    }, scope: function(scopeId) {
      var sv = window.stx && window.stx._scopes ? window.stx._scopes[scopeId] : null;
      return sv ? __stxDevtoolsClassify(sv) : null;
    }, inspect: function(el) {
      var s = el;
      while (s && !(s.getAttribute && s.getAttribute("data-stx-scope")))
        s = s.parentElement;
      return s ? this.scope(s.getAttribute("data-stx-scope")) : null;
    }, stores: function() {
      var out = {};
      var reg = window.stx && window.stx._stores;
      if (reg && typeof reg.forEach === "function")
        reg.forEach(function(v, k) {
          out[k] = true;
        });
      return out;
    }, store: function(id) {
      var reg = window.stx && window.stx._stores;
      var s = reg && typeof reg.get === "function" ? reg.get(id) : null;
      return s ? __stxDevtoolsClassify(s) : null;
    } };
    if (window.__stxDomReadyHandler) {
      document.removeEventListener("DOMContentLoaded", window.__stxDomReadyHandler);
    }
    const stxDomReadyHandler = () => {
      const processedScopes = new Set;
      const latestSetup = window.stx._latestSetup;
      const latestSetupName = typeof latestSetup === "function" ? latestSetup.name : "";
      const hasLatestSetupMarker = latestSetupName && Array.from(document.querySelectorAll("[data-stx]")).some((el) => el.getAttribute("data-stx") === latestSetupName);
      if (latestSetup && !hasLatestSetupMarker) {
        try {
          const result = latestSetup();
          if (typeof result === "object" && result !== null)
            Object.assign(componentScope, result);
        } catch (e) {
          console.error("[stx] initial setup error:", e);
        }
      }
      document.querySelectorAll("[data-stx]").forEach((el) => {
        const setupName = el.getAttribute("data-stx");
        if (setupName && window[setupName]) {
          try {
            const result = window[setupName]();
            if (typeof result === "object" && result !== null) {
              Object.assign(componentScope, result);
            }
          } catch (e) {
            console.error('[stx] page setup "' + setupName + '" threw; this root will not hydrate:', e);
          }
        }
      });
      var pageScopeSnapshot = { ...componentScope };
      if (window.__stx_reactive && window.__stx_reactive.initScope) {
        document.querySelectorAll("[data-stx-xdata]").forEach(function(el) {
          var scopeId = el.getAttribute("data-stx-scope");
          if (scopeId && window.stx._scopes && window.stx._scopes[scopeId])
            return;
          if (el.__stx_scope_initialized)
            return;
          var xdata = el.getAttribute("data-stx-xdata");
          if (!xdata)
            return;
          if (!scopeId) {
            scopeId = "__stx_scope_island_" + ++window.stx._scopeCounter;
            el.setAttribute("data-stx-scope", scopeId);
          }
          el.__stx_scope_initialized = true;
          try {
            window.__stx_reactive.initScope(el, xdata, [], {}, el.getAttribute("data-stx-xinit") || null);
          } catch (e) {
            console.error("[stx] island scope init error:", e);
          }
        });
      }
      mountQueue.forEach(function(fn) {
        fn();
      });
      mountQueue = [];
      document.querySelectorAll("[data-stx]").forEach((el) => {
        var disposeEffects = trackEffects(function() {
          if (!processFromManifest(el, componentScope, window.__stx_bindings))
            processElement(el);
        });
        el.__stx_disposers = disposeEffects;
        el.removeAttribute("x-cloak");
        el.querySelectorAll("[x-cloak]").forEach(function(c) {
          c.removeAttribute("x-cloak");
        });
        runMountCallbacks(mountCallbacks, destroyCallbacks);
      });
      var stxRoots = document.querySelectorAll("[data-stx]");
      if (stxRoots.length && Object.keys(componentScope).length) {
        var rootParent = stxRoots[0].parentNode;
        if (rootParent && rootParent.children) {
          Array.prototype.slice.call(rootParent.children).forEach(function(sib) {
            if (sib.nodeType !== 1)
              return;
            if (sib.hasAttribute("data-stx") || sib.hasAttribute("data-stx-scope"))
              return;
            if (sib.tagName === "SCRIPT" || sib.tagName === "STYLE")
              return;
            if (sib.__stx_disposers)
              return;
            var disposeSib = trackEffects(function() {
              processElement(sib);
            });
            sib.__stx_disposers = disposeSib;
            sib.removeAttribute("x-cloak");
            sib.querySelectorAll("[x-cloak]").forEach(function(c) {
              c.removeAttribute("x-cloak");
            });
          });
        }
      }
      var allScopes = document.querySelectorAll("[data-stx-scope]");
      allScopes.forEach((el) => {
        const scopeId = el.getAttribute("data-stx-scope");
        processedScopes.add(el);
        const scopeVars = window.stx._scopes && window.stx._scopes[scopeId];
        if (scopeVars)
          scopeVars.__el = el;
        var isDeferredIsland = !scopeVars && el.hasAttribute && el.hasAttribute("stx-hydrate") && !!document.querySelector('script[data-stx-island="' + scopeId + '"]');
        if (isDeferredIsland) {
          processElement(el);
          el.removeAttribute("x-cloak");
          el.querySelectorAll("[x-cloak]").forEach(function(c) {
            c.removeAttribute("x-cloak");
          });
          return;
        }
        if (!scopeVars)
          return;
        el.__stx_parent_scope = el.__stx_parent_scope || resolveComponentCallerScope(el, pageScopeSnapshot);
        bindParentComponentProps(el, el.__stx_parent_scope);
        if (scopeVars) {
          componentScope = { ...componentScope, ...scopeVars };
        }
        var disposeEffects = trackEffects(function() {
          processElement(el);
        });
        el.__stx_disposers = disposeEffects;
        el.removeAttribute("x-cloak");
        el.querySelectorAll("[x-cloak]").forEach(function(c) {
          c.removeAttribute("x-cloak");
        });
        var scopeDeferred = el.hasAttribute && el.hasAttribute("stx-hydrate") && !el.__stx_hydrated;
        var scopeDetached = el.isConnected === false;
        if (scopeVars && scopeVars.__mountCallbacks && !scopeVars.__mounted && !scopeDeferred && !scopeDetached) {
          scopeVars.__mounted = true;
          runMountCallbacks(scopeVars.__mountCallbacks, scopeDestroySink(scopeVars));
        }
      });
      runMountCallbacks(mountCallbacks, destroyCallbacks);
      mountCallbacks.length = 0;
      document.querySelectorAll("[data-stx-auto]").forEach((el) => {
        processElementSkipScopes(el, processedScopes);
        el.removeAttribute("x-cloak");
        el.querySelectorAll("[x-cloak]").forEach(function(c) {
          c.removeAttribute("x-cloak");
        });
      });
      const headElements = document.querySelectorAll("head title, head meta[content]");
      headElements.forEach((el) => {
        if (el.tagName === "TITLE") {
          const text = el.textContent;
          if (text && text.includes("{{")) {
            effect(() => {
              try {
                let result = text;
                const matches = text.match(/\{\{\s*(.+?)\s*\}\}/g);
                if (matches) {
                  matches.forEach((match) => {
                    const expr = match.replace(/^\{\{\s*|\s*\}\}$/g, "");
                    const fn = __stxCompileScoped(componentScope, [], "return " + expr);
                    const value = fn(...__stxArgs(fn, componentScope));
                    result = result.replace(match, value != null ? value : "");
                  });
                }
                el.textContent = result;
              } catch (e) {
                if (!(e instanceof ReferenceError) && !(e instanceof TypeError))
                  console.warn("[STX] Title expression error:", e);
              }
            });
          }
        } else if (el.tagName === "META") {
          const content = el.getAttribute("content");
          if (content && content.includes("{{")) {
            const hasOnlyPlaceholders = !content.replace(/\{\{\s*__[A-Z_]+__\s*\}\}/g, "").includes("{{");
            if (hasOnlyPlaceholders)
              return;
            effect(() => {
              try {
                let result = content;
                const matches = content.match(/\{\{\s*(.+?)\s*\}\}/g);
                if (matches) {
                  matches.forEach((match) => {
                    const expr = match.replace(/^\{\{\s*|\s*\}\}$/g, "");
                    if (/^__[A-Z_]+__$/.test(expr.trim()))
                      return;
                    const fn = __stxCompileScoped(componentScope, [], "return " + expr);
                    const value = fn(...__stxArgs(fn, componentScope));
                    result = result.replace(match, value != null ? value : "");
                  });
                }
                el.setAttribute("content", result);
              } catch (e) {
                if (!(e instanceof ReferenceError) && !(e instanceof TypeError))
                  console.warn("[STX] Meta expression error:", e);
              }
            });
          }
        }
      });
      auditHydration(document.body, "DOMContentLoaded");
    };
    window.__stxDomReadyHandler = stxDomReadyHandler;
    document.addEventListener("DOMContentLoaded", stxDomReadyHandler);
    function disposeSubtreeEffects(root) {
      if (!root)
        return;
      var nodes = stxHost.descendants(root);
      nodes.push(root);
      var owned = ["__stx_disposers", "__stx_effect_disposers", "__stx_if_disposers", "__stx_chain_disposers"];
      for (var n = 0;n < nodes.length; n++) {
        var el = nodes[n];
        if (typeof el.__stx_hydration_cancel === "function") {
          try {
            el.__stx_hydration_cancel();
          } catch (e) {}
          el.__stx_hydration_cancel = null;
        }
        if (Array.isArray(el.__stx_destroy)) {
          var hooks = el.__stx_destroy;
          el.__stx_destroy = null;
          hooks.forEach(function(fn) {
            try {
              fn();
            } catch (e) {
              console.warn("[stx] destroy hook error:", e);
            }
          });
        }
        if (el.__stx_detached_if) {
          var detached = el.__stx_detached_if;
          el.__stx_detached_if = null;
          detached.forEach(function(node) {
            disposeSubtreeEffects(node);
          });
        }
        for (var k = 0;k < owned.length; k++) {
          var disposeOwned = el[owned[k]];
          if (typeof disposeOwned === "function") {
            el[owned[k]] = null;
            disposeOwned();
          }
        }
      }
    }
    function disposeSubtreeScopes(root) {
      if (!root || !window.stx || !window.stx._scopes)
        return;
      var scopeIds = stxHost.scopesIn(root);
      for (var n = 0;n < scopeIds.length; n++) {
        var scopeId = scopeIds[n];
        if (!scopeId)
          continue;
        var scopeVars = window.stx._scopes[scopeId];
        if (!scopeVars)
          continue;
        if (scopeVars.__destroyCallbacks && Array.isArray(scopeVars.__destroyCallbacks)) {
          for (var j = 0;j < scopeVars.__destroyCallbacks.length; j++) {
            try {
              scopeVars.__destroyCallbacks[j]();
            } catch (e) {
              console.warn("[stx] scope destroy error:", e);
            }
          }
        }
        delete window.stx._scopes[scopeId];
      }
    }
    function sweepOrphanedScopes() {
      if (!window.stx || !window.stx._scopes)
        return;
      var scopes = window.stx._scopes;
      for (var id in scopes) {
        if (!Object.prototype.hasOwnProperty.call(scopes, id))
          continue;
        var entry = scopes[id];
        if (!entry)
          continue;
        var el = entry.__el;
        if (!el || el.isConnected)
          continue;
        var retained = false;
        for (var p = el;p; p = p.parentNode) {
          if (p.__stx_if_bound || p.__stx_chain_member) {
            retained = true;
            break;
          }
        }
        if (retained)
          continue;
        if (entry.__destroyCallbacks && Array.isArray(entry.__destroyCallbacks)) {
          for (var k = 0;k < entry.__destroyCallbacks.length; k++) {
            try {
              entry.__destroyCallbacks[k]();
            } catch (e) {
              console.warn("[stx] scope destroy error:", e);
            }
          }
        }
        delete scopes[id];
      }
    }
    var AUDIT_SKIP_TAGS = { PRE: 1, CODE: 1, SCRIPT: 1, STYLE: 1, TEXTAREA: 1, TEMPLATE: 1 };
    var _exprFailures = {};
    var _exprFailureCount = 0;
    function noteExprFailure(expr, err) {
      if (_exprFailures[expr] !== undefined)
        return;
      if (_exprFailureCount >= 50)
        return;
      _exprFailureCount++;
      _exprFailures[expr] = err && err.message ? err.message : String(err);
    }
    function noteExprSuccess(expr) {
      if (_exprFailures[expr] === undefined)
        return;
      delete _exprFailures[expr];
      _exprFailureCount--;
    }
    function auditSkipped(node) {
      if (node.isConnected === false)
        return true;
      for (var p = node.parentNode;p; p = p.parentNode) {
        if (p.nodeType === Node.DOCUMENT_FRAGMENT_NODE)
          return true;
        if (p.nodeType !== Node.ELEMENT_NODE)
          continue;
        if (AUDIT_SKIP_TAGS[p.tagName])
          return true;
        if (p.hasAttribute && p.hasAttribute("data-stx-ignore"))
          return true;
        if (p.__stx_if_pending)
          return true;
        if (p.hasAttribute && p.hasAttribute("stx-hydrate") && !p.__stx_hydrated)
          return true;
      }
      return false;
    }
    function findLiteralMoustaches(root) {
      var found = [];
      if (!root || typeof document.createTreeWalker !== "function")
        return found;
      var showText = window.NodeFilter && window.NodeFilter.SHOW_TEXT || 4;
      var walker = document.createTreeWalker(root, showText, null);
      var node;
      while (node = walker.nextNode()) {
        var text = node.nodeValue == null ? "" : String(node.nodeValue);
        if (text.indexOf("{{") === -1 || text.indexOf("}}") === -1)
          continue;
        if (auditSkipped(node))
          continue;
        found.push(text.trim().slice(0, 80));
        if (found.length >= 5)
          break;
      }
      return found;
    }
    function auditHydration(container, phase) {
      try {
        auditHydrationUnsafe(container, phase);
      } catch (e) {
        console.warn("[stx] hydration audit skipped:", e && e.message ? e.message : e);
      }
    }
    function auditHydrationUnsafe(container, phase) {
      if (!window.stx || !window.stx._scopes)
        return;
      var root = container && typeof container.querySelectorAll === "function" ? container : document.body;
      if (!root || typeof root.querySelectorAll !== "function")
        return;
      var stranded = [];
      root.querySelectorAll("[data-stx-scope]").forEach(function(el) {
        if (el.__stx_audit_recovered)
          return;
        if (el.hasAttribute("stx-hydrate") || el.__stx_hydration_scheduled)
          return;
        var scopeId = el.getAttribute("data-stx-scope");
        var registered = window.stx._scopes[scopeId];
        if (registered && el.__stx_disposers)
          return;
        stranded.push({ el, id: scopeId, registered: !!registered });
      });
      if (stranded.length) {
        console.error("[stx] hydration invariant failed after " + phase + ": " + stranded.length + " scope(s) left unhydrated — " + stranded.map(function(s) {
          return s.id + (s.registered ? " (registered, never processed)" : " (not registered)");
        }).join(", ") + ". Recovering with the ambient scope; please report with the page that produced it (stacksjs/stx#1773).");
        stranded.forEach(function(s) {
          s.el.__stx_audit_recovered = true;
          try {
            var vars = s.registered ? window.stx._scopes[s.id] : null;
            if (vars)
              Object.assign(componentScope, vars);
            s.el.__stx_disposers = trackEffects(function() {
              processElement(s.el, componentScope);
            });
            s.el.removeAttribute("x-cloak");
            s.el.querySelectorAll("[x-cloak]").forEach(function(c) {
              c.removeAttribute("x-cloak");
            });
          } catch (e) {
            console.error("[stx] hydration recovery failed for scope " + s.id + ":", e);
          }
        });
      }
      var literals = findLiteralMoustaches(root);
      if (literals.length) {
        console.error("[stx] hydration invariant failed after " + phase + ": literal {{ }} left in the DOM — " + literals.join(" | ") + ". An expression did not bind; see stacksjs/stx#1773. Wrap intentional " + "template syntax in <pre>/<code> or [data-stx-ignore] to exclude it.");
      }
      var brokenExprs = [];
      for (var expr in _exprFailures) {
        if (Object.prototype.hasOwnProperty.call(_exprFailures, expr))
          brokenExprs.push(expr + " → " + _exprFailures[expr]);
      }
      if (brokenExprs.length) {
        var hint = brokenExprs.some(function(m) {
          return m.indexOf("is not a function") !== -1;
        }) ? " If one of these calls a signal, drop the parentheses: templates read " + 'a signal by bare name (:if="flag"), scripts call it (flag()). Calling ' + "the unwrapped value is a TypeError, which directives suppress — the " + "element just stays hidden." : "";
        console.error("[stx] hydration invariant failed after " + phase + ": " + brokenExprs.length + " expression(s) never evaluated — " + brokenExprs.slice(0, 5).join(" | ") + "." + hint);
        _exprFailures = {};
        _exprFailureCount = 0;
      }
    }
    function cleanupContainer(container) {
      if (!container)
        return;
      mountCallbacks.length = 0;
      var preservedRefs = componentScope.$refs || {};
      componentScope = { $refs: preservedRefs };
      var shellElements = document.querySelectorAll("[data-stx-content] ~ *");
      document.querySelectorAll("body > *").forEach(function(el) {
        if (el === container)
          return;
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE")
          return;
        if (el.__stx_scope)
          Object.assign(componentScope, el.__stx_scope);
      });
      disposeSubtreeEffects(container);
      container.__stx_scope = null;
      disposeSubtreeScopes(container);
      sweepOrphanedScopes();
    }
    var _stxLoadTimer = null;
    if (window.__stxLoadHandler) {
      window.removeEventListener("stx:load", window.__stxLoadHandler);
    }
    function stxLoadHandler() {
      if (_stxLoadTimer) {
        clearTimeout(_stxLoadTimer);
      }
      _stxLoadTimer = setTimeout(_handleStxLoad, 5);
    }
    window.__stxLoadHandler = stxLoadHandler;
    window.addEventListener("stx:load", stxLoadHandler);
    function flushStxLoad() {
      if (!_stxLoadTimer)
        return false;
      clearTimeout(_stxLoadTimer);
      _handleStxLoad();
      return true;
    }
    function _handleStxLoad() {
      _stxLoadTimer = null;
      destroyCallbacks.forEach(function(fn) {
        try {
          fn();
        } catch (e) {
          console.warn("[stx] destroy callback error:", e);
        }
      });
      destroyCallbacks.length = 0;
      var routerOpts = window.STX_ROUTER_OPTIONS || window.__stxRouterConfig || {};
      var container = document.querySelector("[data-stx-content]") || (routerOpts.container ? document.querySelector(routerOpts.container) : null) || document.querySelector("main") || document.querySelector("#main-content") || document.body;
      var usedLatestSetup = false;
      if (window.stx._latestSetup && typeof window.stx._latestSetup === "function") {
        try {
          var setupResult = window.stx._latestSetup();
          usedLatestSetup = true;
          if (typeof setupResult === "object" && setupResult !== null) {
            Object.assign(componentScope, setupResult);
          }
        } catch (e) {
          console.error("[stx:load] _latestSetup error:", e);
          usedLatestSetup = true;
        }
      }
      if (!usedLatestSetup) {
        document.querySelectorAll("[data-stx]").forEach(function(el) {
          var setupName = el.getAttribute("data-stx");
          if (setupName && window[setupName]) {
            var result = window[setupName]();
            if (typeof result === "object")
              Object.assign(componentScope, result);
          }
        });
      }
      var spaPageScopeSnapshot = { ...componentScope };
      mountQueue.forEach(function(fn) {
        fn();
      });
      mountQueue = [];
      if (window.__stx_reactive && window.__stx_reactive.initScope) {
        container.querySelectorAll("[data-stx-xdata]").forEach(function(el) {
          var scopeId = el.getAttribute("data-stx-scope");
          if (scopeId && window.stx._scopes && window.stx._scopes[scopeId])
            return;
          var xdata = el.getAttribute("data-stx-xdata");
          if (!xdata)
            return;
          if (!scopeId) {
            scopeId = "__stx_scope_spa_" + ++window.stx._scopeCounter;
            el.setAttribute("data-stx-scope", scopeId);
          }
          var xinit = el.getAttribute("data-stx-xinit");
          window.__stx_reactive.initScope(el, xdata, [], {}, xinit || null);
        });
      }
      document.body.querySelectorAll("[data-stx-scope]").forEach(function(el) {
        var scopeId = el.getAttribute("data-stx-scope");
        var scopeVars = window.stx._scopes && window.stx._scopes[scopeId];
        if (scopeVars)
          scopeVars.__el = el;
        if (!scopeVars && el.hasAttribute && el.hasAttribute("stx-hydrate") && !el.__stx_hydration_scheduled && document.querySelector('script[data-stx-island="' + scopeId + '"]')) {
          processElement(el, componentScope);
          el.removeAttribute("x-cloak");
          el.querySelectorAll("[x-cloak]").forEach(function(c) {
            c.removeAttribute("x-cloak");
          });
          return;
        }
        if (!scopeVars)
          return;
        el.__stx_parent_scope = el.__stx_parent_scope || resolveComponentCallerScope(el, spaPageScopeSnapshot);
        bindParentComponentProps(el, el.__stx_parent_scope);
        if (el.__stx_disposers)
          return;
        Object.assign(componentScope, scopeVars);
        var disposeEffects = trackEffects(function() {
          processElement(el, componentScope);
        });
        el.__stx_disposers = disposeEffects;
        el.removeAttribute("x-cloak");
        el.querySelectorAll("[x-cloak]").forEach(function(c) {
          c.removeAttribute("x-cloak");
        });
      });
      if (!container.__stx_scope) {
        if (container.__stx_disposers && typeof container.__stx_disposers === "function") {
          container.__stx_disposers();
        }
        var disposeEffects = trackEffects(function() {
          processElement(container, componentScope);
        });
        container.__stx_disposers = disposeEffects;
      }
      container.removeAttribute("x-cloak");
      container.querySelectorAll("[x-cloak]").forEach(function(c) {
        c.removeAttribute("x-cloak");
      });
      document.body.querySelectorAll("[data-stx-scope]").forEach(function(el) {
        var scopeId = el.getAttribute("data-stx-scope");
        var scopeVars = window.stx._scopes && window.stx._scopes[scopeId];
        if (scopeVars && scopeVars.__mountCallbacks && !scopeVars.__mounted) {
          scopeVars.__mounted = true;
          runMountCallbacks(scopeVars.__mountCallbacks, scopeDestroySink(scopeVars));
        }
      });
      runMountCallbacks(mountCallbacks, destroyCallbacks);
      mountCallbacks.length = 0;
      auditHydration(container, "stx:load");
    }
    function processElementSkipScopes(el, processedScopes) {
      if (processedScopes.has(el))
        return;
      if (el.nodeType === Node.TEXT_NODE) {
        processElement(el);
        return;
      }
      if (el.nodeType !== Node.ELEMENT_NODE)
        return;
      if (el.hasAttribute && el.hasAttribute("data-stx-scope"))
        return;
      if (el.__stx_chain_member && !el.__stx_chain_active)
        return;
      const hasFor = el.hasAttribute && (el.hasAttribute("@for") || el.hasAttribute(":for") || el.hasAttribute("x-for"));
      const hasIf = el.hasAttribute && (el.hasAttribute("@if") || el.hasAttribute(":if") || el.hasAttribute("x-if"));
      if (hasFor) {
        var fa = el.hasAttribute(":for") ? ":for" : el.hasAttribute("x-for") ? "x-for" : "@for";
        bindFor(el, componentScope, fa);
        return;
      }
      if (hasIf) {
        var ia = el.hasAttribute(":if") ? ":if" : el.hasAttribute("x-if") ? "x-if" : "@if";
        var ic = findIfChain(el, ia);
        if (ic.length > 1)
          bindIfChain(ic, componentScope);
        else
          bindIf(el, componentScope, ia);
        return;
      }
      if (el.hasAttribute && (el.hasAttribute("@show") || el.hasAttribute(":show") || el.hasAttribute("x-show"))) {
        var sa = el.hasAttribute(":show") ? ":show" : el.hasAttribute("x-show") ? "x-show" : "@show";
        bindShow(el, el.getAttribute(sa), componentScope, sa);
      }
      var mb = getModelBinding(el);
      if (mb) {
        bindModel(el, mb.expression, componentScope, mb.name);
      }
      if (el.tagName !== "SCRIPT" && el.tagName !== "STYLE") {
        Array.from(el.childNodes).forEach((child) => processElementSkipScopes(child, processedScopes));
      }
    }
  })();
  if (routeName === "manual") {
    let __stx_setup_7d894gptpr = function() {
      const { batch, cachedQuery, clearServerData, computed, configureFetch, defineEmits, defineExpose, definePageMeta, defineProps, defineSlots, defineStore, derived, effect, flushKeptState, forgetKeptState, goForward, inject, invalidateRoute, isDerived, isSignal, keptState, navigate, nextTick, onBeforeMount, onBeforeUnmount, onDestroy, onMount, onMounted, onUnmounted, peek, provide, reactive, ref, refresh, registerStoresClient, setKeptScope, setRouteParams, state, untrack, useAsync, useClickOutside, useColorMode, useCookie, useCounter, useDark, useDebounce, useDebouncedValue, useDocumentVisibility, useEventListener, useFetch, useFocus, useHead, useId, useInterval, useLocalStorage, useMediaQuery, useModel, useMutation, useOptimistic, usePreferredContrast, usePreferredDark, usePreferredLight, usePreferredReducedMotion, useQuery, useReactiveProp, useRef, useRoute, useRouteParam, useRouteParams, useScrollLock, useSearchParams, useSeoMeta, useSessionStorage, useSlots, useStore, useThrottle, useTimeout, useToggle, useWebSocket, watch, watchEffect, watchMultiple, withDefaults } = window.stx;
      var ACTIVITY_VISIBILITIES = undefined;
      var MANUAL_ACTIVITY_TYPES = undefined;
      var active = undefined;
      var buildManualActivity = undefined;
      var craft = undefined;
      var cycleType = undefined;
      var cycleVisibility = undefined;
      var date = undefined;
      var distance = undefined;
      var duration = undefined;
      var elevation = undefined;
      var error = undefined;
      var eventText = undefined;
      var goBack = undefined;
      var messageFrom = undefined;
      var notes = undefined;
      var saving = undefined;
      var submit = undefined;
      var todayLocal = undefined;
      var trailId = undefined;
      var typeIndex = undefined;
      var types = undefined;
      var visibilities = undefined;
      var visibilityIndex = undefined;
      var __stxBundle_559fa667b126 = function() {
        function parseDurationToSeconds(raw) {
          const m = raw.trim().match(/^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/);
          if (!m)
            return null;
          const hours = m[1] ? Number(m[1]) : 0;
          return hours * 3600 + Number(m[2]) * 60 + Number(m[3]);
        }
        function paceString(distanceMi, movingSeconds) {
          if (!(distanceMi > 0) || !(movingSeconds > 0))
            return "--";
          const per = Math.round(movingSeconds / distanceMi);
          const mm = Math.floor(per / 60);
          const ss = per % 60;
          return `${mm}:${String(ss).padStart(2, "0")}/mi`;
        }
        var MANUAL_ACTIVITY_TYPES = ["Trail Run", "Hike", "Walk", "Bike"];
        var ACTIVITY_VISIBILITIES = ["public", "followers", "private"];
        function todayLocal(now = new Date) {
          return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        }
        function buildManualActivity(input, userId, options = {}) {
          const now = options.now ?? new Date;
          const distance = Number.parseFloat(input.distance);
          const duration = input.duration.trim();
          const movingSeconds = parseDurationToSeconds(duration);
          const elevation = Math.round(Number.parseFloat(input.elevation || "0"));
          if (!MANUAL_ACTIVITY_TYPES.includes(input.type))
            return { ok: false, error: "Pick an activity type" };
          if (userId !== null && (!Number.isFinite(userId) || userId <= 0))
            return { ok: false, error: "Sign in before saving an activity" };
          if (!Number.isFinite(distance) || distance <= 0)
            return { ok: false, error: "Distance must be a positive number of miles" };
          if (movingSeconds === null)
            return { ok: false, error: "Duration must look like 45:30 or 1:45:30" };
          if (!Number.isFinite(elevation) || elevation < 0)
            return { ok: false, error: "Elevation must be a non-negative number of feet" };
          if (!ACTIVITY_VISIBILITIES.includes(input.visibility))
            return { ok: false, error: "Pick who can see the activity" };
          const trailId = input.trailId.trim() ? Number(input.trailId) : null;
          if (trailId !== null && (!Number.isInteger(trailId) || trailId <= 0))
            return { ok: false, error: "Trail must be a positive whole number" };
          let completedAt = now.toISOString();
          if (input.date && input.date !== todayLocal(now)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date))
              return { ok: false, error: "Date must look like YYYY-MM-DD" };
            const [year, month, day] = input.date.split("-").map(Number);
            const chosen = new Date(`${input.date}T12:00:00`);
            if (!Number.isFinite(chosen.getTime()) || chosen.getFullYear() !== year || chosen.getMonth() + 1 !== month || chosen.getDate() !== day)
              return { ok: false, error: "Date is not valid" };
            completedAt = chosen.toISOString();
          }
          const notes = input.notes.trim();
          return {
            ok: true,
            movingSeconds,
            payload: {
              ...userId === null ? {} : { user_id: userId },
              trail_id: trailId,
              activity_type: input.type,
              distance: Number(distance.toFixed(2)),
              duration,
              moving_time: duration,
              pace: paceString(distance, movingSeconds),
              elevation,
              notes: notes || undefined,
              visibility: input.visibility,
              completed_at: completedAt,
              upload_id: options.uploadId ?? `manual:${now.getTime()}:${Math.random().toString(36).slice(2)}`,
              recording_source: "manual",
              game_mode: "none"
            }
          };
        }
        var craft = globalThis.craft;
        var types = [...MANUAL_ACTIVITY_TYPES];
        var visibilities = [...ACTIVITY_VISIBILITIES];
        var typeIndex = state(0);
        var visibilityIndex = state(1);
        var distance = state("");
        var duration = state("");
        var elevation = state("");
        var trailId = state("");
        var date = state(todayLocal());
        var notes = state("");
        var saving = state(false);
        var error = state("");
        var active = true;
        function eventText(event) {
          return event?.text == null ? "" : String(event.text);
        }
        function cycleType() {
          typeIndex.set((typeIndex() + 1) % types.length);
        }
        function cycleVisibility() {
          visibilityIndex.set((visibilityIndex() + 1) % visibilities.length);
        }
        function goBack() {
          craft.navigation.back();
        }
        async function messageFrom(response, fallback) {
          const body = await response.json().catch(() => null);
          const fields = body?.fields ?? body?.errors;
          const message = fields && typeof fields === "object" ? Object.values(fields).map(String).join(" ") : String(body?.message ?? fallback);
          return { body, message };
        }
        async function submit() {
          if (saving())
            return;
          const built = buildManualActivity({
            type: types[typeIndex()],
            distance: distance(),
            duration: duration(),
            elevation: elevation(),
            trailId: trailId(),
            date: date(),
            notes: notes(),
            visibility: visibilities[visibilityIndex()]
          }, null);
          if (built.ok === false) {
            error.set(built.error);
            return;
          }
          saving.set(true);
          error.set("");
          try {
            const token = await craft.secureStorage.get("auth_token");
            if (!token)
              throw new Error("Sign in before saving an activity");
            const response = await fetch("https://wildloop.org/api/activities", {
              method: "POST",
              headers: {
                Accept: "application/json",
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify(built.payload)
            });
            const result = await messageFrom(response, "Could not save the activity");
            if (!response.ok)
              throw new Error(result.message);
            const created = result.body?.activity;
            if (!created?.id)
              throw new Error("Wildloop did not return the saved activity");
            if (!active)
              return;
            await craft.haptics.notification("success");
            if (!active)
              return;
            craft.navigation.push("activity", {
              id: created.id,
              userId: created.userId ?? 0,
              activityType: built.payload.activity_type,
              distance: built.payload.distance,
              duration: built.payload.duration,
              pace: built.payload.pace,
              elevation: built.payload.elevation,
              completedAt: built.payload.completed_at
            });
          } catch (cause) {
            if (active)
              error.set(cause instanceof Error ? cause.message : "Could not save the activity");
          } finally {
            if (active)
              saving.set(false);
          }
        }
        onMount(() => {
          craft.navigation.setOptions({ title: "Log activity", largeTitle: true });
        });
        onDestroy(() => {
          active = false;
        });
        return { ACTIVITY_VISIBILITIES, MANUAL_ACTIVITY_TYPES, active, buildManualActivity, craft, cycleType, cycleVisibility, date, distance, duration, elevation, error, eventText, goBack, messageFrom, notes, saving, submit, todayLocal, trailId, typeIndex, types, visibilities, visibilityIndex };
      }();
      ACTIVITY_VISIBILITIES = __stxBundle_559fa667b126["ACTIVITY_VISIBILITIES"];
      MANUAL_ACTIVITY_TYPES = __stxBundle_559fa667b126["MANUAL_ACTIVITY_TYPES"];
      active = __stxBundle_559fa667b126["active"];
      buildManualActivity = __stxBundle_559fa667b126["buildManualActivity"];
      craft = __stxBundle_559fa667b126["craft"];
      cycleType = __stxBundle_559fa667b126["cycleType"];
      cycleVisibility = __stxBundle_559fa667b126["cycleVisibility"];
      date = __stxBundle_559fa667b126["date"];
      distance = __stxBundle_559fa667b126["distance"];
      duration = __stxBundle_559fa667b126["duration"];
      elevation = __stxBundle_559fa667b126["elevation"];
      error = __stxBundle_559fa667b126["error"];
      eventText = __stxBundle_559fa667b126["eventText"];
      goBack = __stxBundle_559fa667b126["goBack"];
      messageFrom = __stxBundle_559fa667b126["messageFrom"];
      notes = __stxBundle_559fa667b126["notes"];
      saving = __stxBundle_559fa667b126["saving"];
      submit = __stxBundle_559fa667b126["submit"];
      todayLocal = __stxBundle_559fa667b126["todayLocal"];
      trailId = __stxBundle_559fa667b126["trailId"];
      typeIndex = __stxBundle_559fa667b126["typeIndex"];
      types = __stxBundle_559fa667b126["types"];
      visibilities = __stxBundle_559fa667b126["visibilities"];
      visibilityIndex = __stxBundle_559fa667b126["visibilityIndex"];
      return { ACTIVITY_VISIBILITIES, MANUAL_ACTIVITY_TYPES, active, buildManualActivity, craft, cycleType, cycleVisibility, date, distance, duration, elevation, error, eventText, goBack, messageFrom, notes, saving, submit, todayLocal, trailId, typeIndex, types, visibilities, visibilityIndex, __stxBundle_559fa667b126 };
    };
    window.__stx_latestSetup = __stx_setup_7d894gptpr;
    if (window.stx)
      window.stx._latestSetup = __stx_setup_7d894gptpr;
  } else if (routeName === "activity") {
    let __stx_setup_2u0xf7j4l1 = function() {
      const { batch, cachedQuery, clearServerData, computed, configureFetch, defineEmits, defineExpose, definePageMeta, defineProps, defineSlots, defineStore, derived, effect, flushKeptState, forgetKeptState, goForward, inject, invalidateRoute, isDerived, isSignal, keptState, navigate, nextTick, onBeforeMount, onBeforeUnmount, onDestroy, onMount, onMounted, onUnmounted, peek, provide, reactive, ref, refresh, registerStoresClient, setKeptScope, setRouteParams, state, untrack, useAsync, useClickOutside, useColorMode, useCookie, useCounter, useDark, useDebounce, useDebouncedValue, useDocumentVisibility, useEventListener, useFetch, useFocus, useHead, useId, useInterval, useLocalStorage, useMediaQuery, useModel, useMutation, useOptimistic, usePreferredContrast, usePreferredDark, usePreferredLight, usePreferredReducedMotion, useQuery, useReactiveProp, useRef, useRoute, useRouteParam, useRouteParams, useScrollLock, useSearchParams, useSeoMeta, useSessionStorage, useSlots, useStore, useThrottle, useTimeout, useToggle, useWebSocket, watch, watchEffect, watchMultiple, withDefaults } = window.stx;
      const craft = globalThis.craft;
      const params = craft.route.params;
      const id = state(String(params.id ?? ""));
      const userId = Number(params.userId ?? 0);
      const activityType = state(String(params.activityType ?? "Activity"));
      const distance = state(Number(params.distance ?? 0));
      const duration = state(String(params.duration ?? "--"));
      const pace = state(String(params.pace ?? "--"));
      const elevation = state(Number(params.elevation ?? 0));
      function goBack() {
        craft.navigation.back();
      }
      function logAnother() {
        craft.navigation.replace("manual", { userId });
      }
      onMount(() => {
        craft.navigation.setOptions({ title: "Activity saved", largeTitle: false });
      });
      return { craft, params, id, userId, activityType, distance, duration, pace, elevation, goBack, logAnother };
    };
    window.__stx_latestSetup = __stx_setup_2u0xf7j4l1;
    if (window.stx)
      window.stx._latestSetup = __stx_setup_2u0xf7j4l1;
  } else if (routeName === "records") {
    let __stx_setup_3mxivmfhgr = function() {
      const { batch, cachedQuery, clearServerData, computed, configureFetch, defineEmits, defineExpose, definePageMeta, defineProps, defineSlots, defineStore, derived, effect, flushKeptState, forgetKeptState, goBack, goForward, inject, invalidateRoute, isDerived, isSignal, keptState, navigate, nextTick, onBeforeMount, onBeforeUnmount, onDestroy, onMount, onMounted, onUnmounted, peek, provide, reactive, ref, refresh, registerStoresClient, setKeptScope, setRouteParams, state, untrack, useAsync, useClickOutside, useColorMode, useCookie, useCounter, useDark, useDebounce, useDebouncedValue, useDocumentVisibility, useEventListener, useFetch, useFocus, useHead, useId, useInterval, useLocalStorage, useMediaQuery, useModel, useMutation, useOptimistic, usePreferredContrast, usePreferredDark, usePreferredLight, usePreferredReducedMotion, useQuery, useReactiveProp, useRef, useRoute, useRouteParam, useRouteParams, useScrollLock, useSearchParams, useSeoMeta, useSessionStorage, useSlots, useStore, useThrottle, useTimeout, useToggle, useWebSocket, watch, watchEffect, watchMultiple, withDefaults } = window.stx;
      var CATEGORY_LABELS = undefined;
      var RECORD_STYLES = undefined;
      var STATUS_LABELS = undefined;
      var STYLE_CHOICES = undefined;
      var STYLE_LABELS = undefined;
      var active = undefined;
      var craft = undefined;
      var cycleStyle = undefined;
      var error = undefined;
      var formatElapsed = undefined;
      var load = undefined;
      var loading = undefined;
      var openEffort = undefined;
      var recordPace = undefined;
      var rowFrom = undefined;
      var rows = undefined;
      var styleIndex = undefined;
      var styleLabel = undefined;
      var __stxBundle_e208c941ccf1 = function() {
        var RECORD_STYLES = ["supported", "self_supported", "unsupported"];
        var STYLE_LABELS = {
          supported: "Supported",
          self_supported: "Self-supported",
          unsupported: "Unsupported"
        };
        var CATEGORY_LABELS = {
          mens: "Men's",
          womens: "Women's",
          nonbinary: "Non-binary"
        };
        var STATUS_LABELS = {
          in_progress: "In progress",
          dnf: "DNF",
          pending: "Pending verification",
          verified: "Verified",
          rejected: "Not accepted"
        };
        function formatElapsed(seconds) {
          const total = Number(seconds);
          if (!Number.isFinite(total) || total <= 0)
            return "—";
          const days = Math.floor(total / 86400);
          const hours = Math.floor(total % 86400 / 3600);
          const minutes = Math.floor(total % 3600 / 60);
          const secs = Math.floor(total % 60);
          if (days > 0)
            return `${days}d ${hours}h ${String(minutes).padStart(2, "0")}m`;
          if (hours > 0)
            return `${hours}h ${String(minutes).padStart(2, "0")}m`;
          return `${minutes}m ${String(secs).padStart(2, "0")}s`;
        }
        function recordPace(distanceMi, seconds) {
          const total = Number(seconds);
          if (!(distanceMi > 0) || !Number.isFinite(total) || total <= 0)
            return "—";
          const per = Math.round(total / distanceMi);
          return `${Math.floor(per / 60)}:${String(per % 60).padStart(2, "0")}/mi`;
        }
        var craft = globalThis.craft;
        var STYLE_CHOICES = ["all", ...RECORD_STYLES];
        var styleIndex = state(0);
        var rows = state([]);
        var loading = state(true);
        var error = state("");
        var active = true;
        function styleLabel() {
          const choice = STYLE_CHOICES[styleIndex()];
          return choice === "all" ? "Every style" : STYLE_LABELS[choice];
        }
        function rowFrom(effort) {
          const miles = Number(effort?.trailDistance) || 0;
          const seconds = effort?.elapsedSeconds == null ? null : Number(effort.elapsedSeconds);
          return {
            id: Number(effort?.id) || 0,
            trailId: Number(effort?.trailId) || 0,
            trailName: String(effort?.trailName ?? "Unnamed trail"),
            where: String(effort?.trailLocation ?? ""),
            who: String(effort?.userName ?? "Someone"),
            elapsed: formatElapsed(seconds),
            pace: miles > 0 && seconds ? recordPace(miles, seconds) : "",
            status: STATUS_LABELS[effort?.status] ?? String(effort?.status ?? ""),
            kind: [
              STYLE_LABELS[effort?.style] ?? "",
              CATEGORY_LABELS[effort?.category] ?? ""
            ].filter(Boolean).join(" · ")
          };
        }
        async function load() {
          loading.set(true);
          error.set("");
          const choice = STYLE_CHOICES[styleIndex()];
          const query = choice === "all" ? "limit=40" : `limit=40&style=${choice}`;
          try {
            const response = await fetch(`https://wildloop.org/api/route-efforts?${query}`, {
              headers: { Accept: "application/json" }
            });
            const body = await response.json().catch(() => null);
            if (!active)
              return;
            if (!response.ok || !Array.isArray(body?.efforts))
              throw new Error("Could not reach the records service");
            rows.set(body.efforts.map(rowFrom));
          } catch (cause) {
            if (active)
              error.set(cause instanceof Error ? cause.message : "Could not reach the records service");
          } finally {
            if (active)
              loading.set(false);
          }
        }
        function cycleStyle() {
          styleIndex.set((styleIndex() + 1) % STYLE_CHOICES.length);
          load();
        }
        function openEffort(id) {
          craft.navigation.open(`/effort/${id}`);
        }
        onMount(() => {
          craft.navigation.setOptions({ title: "Records", largeTitle: true });
          const cached = craft.snapshots.get("records");
          if (Array.isArray(cached) && cached.length > 0) {
            rows.set(cached.map(rowFrom));
            loading.set(false);
          }
          load();
        });
        onDestroy(() => {
          active = false;
        });
        return { CATEGORY_LABELS, RECORD_STYLES, STATUS_LABELS, STYLE_CHOICES, STYLE_LABELS, active, craft, cycleStyle, error, formatElapsed, load, loading, openEffort, recordPace, rowFrom, rows, styleIndex, styleLabel };
      }();
      CATEGORY_LABELS = __stxBundle_e208c941ccf1["CATEGORY_LABELS"];
      RECORD_STYLES = __stxBundle_e208c941ccf1["RECORD_STYLES"];
      STATUS_LABELS = __stxBundle_e208c941ccf1["STATUS_LABELS"];
      STYLE_CHOICES = __stxBundle_e208c941ccf1["STYLE_CHOICES"];
      STYLE_LABELS = __stxBundle_e208c941ccf1["STYLE_LABELS"];
      active = __stxBundle_e208c941ccf1["active"];
      craft = __stxBundle_e208c941ccf1["craft"];
      cycleStyle = __stxBundle_e208c941ccf1["cycleStyle"];
      error = __stxBundle_e208c941ccf1["error"];
      formatElapsed = __stxBundle_e208c941ccf1["formatElapsed"];
      load = __stxBundle_e208c941ccf1["load"];
      loading = __stxBundle_e208c941ccf1["loading"];
      openEffort = __stxBundle_e208c941ccf1["openEffort"];
      recordPace = __stxBundle_e208c941ccf1["recordPace"];
      rowFrom = __stxBundle_e208c941ccf1["rowFrom"];
      rows = __stxBundle_e208c941ccf1["rows"];
      styleIndex = __stxBundle_e208c941ccf1["styleIndex"];
      styleLabel = __stxBundle_e208c941ccf1["styleLabel"];
      return { CATEGORY_LABELS, RECORD_STYLES, STATUS_LABELS, STYLE_CHOICES, STYLE_LABELS, active, craft, cycleStyle, error, formatElapsed, load, loading, openEffort, recordPace, rowFrom, rows, styleIndex, styleLabel, __stxBundle_e208c941ccf1 };
    };
    window.__stx_latestSetup = __stx_setup_3mxivmfhgr;
    if (window.stx)
      window.stx._latestSetup = __stx_setup_3mxivmfhgr;
  } else if (routeName === "notifications") {
    let __stx_setup_rxae00qm1c = function() {
      const { batch, cachedQuery, clearServerData, computed, configureFetch, defineEmits, defineExpose, definePageMeta, defineProps, defineSlots, defineStore, derived, effect, flushKeptState, forgetKeptState, goBack, goForward, inject, invalidateRoute, isDerived, isSignal, keptState, navigate, nextTick, onBeforeMount, onBeforeUnmount, onDestroy, onMount, onMounted, onUnmounted, peek, provide, reactive, ref, refresh, registerStoresClient, setKeptScope, setRouteParams, state, untrack, useAsync, useClickOutside, useColorMode, useCookie, useCounter, useDark, useDebounce, useDebouncedValue, useDocumentVisibility, useEventListener, useFetch, useFocus, useHead, useId, useInterval, useLocalStorage, useMediaQuery, useModel, useMutation, useOptimistic, usePreferredContrast, usePreferredDark, usePreferredLight, usePreferredReducedMotion, useQuery, useReactiveProp, useRef, useRoute, useRouteParam, useRouteParams, useScrollLock, useSearchParams, useSeoMeta, useSessionStorage, useSlots, useStore, useThrottle, useTimeout, useToggle, useWebSocket, watch, watchEffect, watchMultiple, withDefaults } = window.stx;
      var FILTERS = undefined;
      var NOTIFICATION_FILTERS = undefined;
      var active = undefined;
      var bearer = undefined;
      var craft = undefined;
      var cycleFilter = undefined;
      var error = undefined;
      var filterIndex = undefined;
      var filterLabel = undefined;
      var groupNotificationsByDay = undefined;
      var load = undefined;
      var loading = undefined;
      var markAllRead = undefined;
      var matchesNotificationFilter = undefined;
      var notificationRowsFrom = undefined;
      var openRow = undefined;
      var readToken = undefined;
      var rows = undefined;
      var sections = undefined;
      var signedOut = undefined;
      var timeAgo = undefined;
      var unread = undefined;
      var __stxBundle_c74a7d2096ba = function() {
        var NOTIFICATION_FILTERS = [
          { key: "all", label: "All" },
          { key: "unread", label: "Unread" },
          { key: "conquest", label: "Conquests" },
          { key: "kudos", label: "Kudos" },
          { key: "challenge", label: "Challenges" }
        ];
        function notificationRowsFrom(payload) {
          const list = payload?.notifications;
          if (!Array.isArray(list))
            return [];
          return list.map((entry) => {
            const row = entry;
            return {
              id: Number(row.id) || 0,
              type: String(row.type ?? ""),
              title: String(row.actorName || "Wildloop"),
              message: String(row.body ?? ""),
              link: String(row.link || "#"),
              read: Boolean(row.read),
              created_at: String(row.createdAt ?? row.created_at ?? "")
            };
          });
        }
        function matchesNotificationFilter(row, filter) {
          if (filter === "all")
            return true;
          if (filter === "unread")
            return !row.read;
          if (filter === "conquest")
            return row.type.startsWith("conquest");
          return row.type === filter;
        }
        function groupNotificationsByDay(rows, now = Date.now()) {
          const DAY = 86400000;
          const buckets = [
            { label: "Today", items: [] },
            { label: "Yesterday", items: [] },
            { label: "Earlier", items: [] }
          ];
          for (const row of rows) {
            const age = now - new Date(row.created_at).getTime();
            if (!Number.isFinite(age) || age >= DAY * 2)
              buckets[2].items.push(row);
            else if (age >= DAY)
              buckets[1].items.push(row);
            else
              buckets[0].items.push(row);
          }
          return buckets.filter((bucket) => bucket.items.length > 0);
        }
        function timeAgo(value, now = Date.now()) {
          if (!value)
            return "";
          const then = new Date(value).getTime();
          if (!Number.isFinite(then))
            return "";
          const minutes = Math.floor((now - then) / 60000);
          if (minutes < 1)
            return "just now";
          if (minutes < 60)
            return `${minutes}m ago`;
          const hours = Math.floor(minutes / 60);
          if (hours < 24)
            return `${hours}h ago`;
          const days = Math.floor(hours / 24);
          if (days < 7)
            return `${days}d ago`;
          return `${Math.floor(days / 7)}w ago`;
        }
        var craft = globalThis.craft;
        var FILTERS = NOTIFICATION_FILTERS.map((filter) => filter.key);
        var filterIndex = state(0);
        var rows = state([]);
        var loading = state(true);
        var error = state("");
        var signedOut = state(false);
        var active = true;
        function filterLabel() {
          return NOTIFICATION_FILTERS[filterIndex()].label;
        }
        function sections() {
          const chosen = FILTERS[filterIndex()];
          return groupNotificationsByDay(rows().filter((row) => matchesNotificationFilter(row, chosen)));
        }
        function unread() {
          return rows().filter((row) => !row.read).length;
        }
        var bearer = state("");
        async function readToken() {
          if (bearer())
            return bearer();
          const value = await craft.secureStorage.get("auth_token");
          const token = typeof value === "string" ? value : "";
          bearer.set(token);
          return token;
        }
        async function load() {
          loading.set(true);
          error.set("");
          try {
            const token = await readToken();
            if (!token) {
              if (active) {
                signedOut.set(true);
                loading.set(false);
              }
              return;
            }
            const response = await fetch("https://wildloop.org/api/notifications", {
              headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
            });
            const body = await response.json().catch(() => null);
            if (!active)
              return;
            if (response.status === 401) {
              signedOut.set(true);
              loading.set(false);
              return;
            }
            if (!response.ok)
              throw new Error("Could not load your notifications");
            signedOut.set(false);
            rows.set(notificationRowsFrom(body));
          } catch (cause) {
            if (active)
              error.set(cause instanceof Error ? cause.message : "Could not load your notifications");
          } finally {
            if (active)
              loading.set(false);
          }
        }
        function cycleFilter() {
          filterIndex.set((filterIndex() + 1) % FILTERS.length);
        }
        async function markAllRead() {
          if (unread() === 0)
            return;
          rows.set(rows().map((row) => ({ ...row, read: true })));
          try {
            const token = await readToken();
            if (!token)
              return;
            await fetch("https://wildloop.org/api/notifications/read", {
              method: "POST",
              headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({})
            });
            if (active)
              await craft.haptics.selection();
          } catch {}
        }
        function openRow(row) {
          if (!row?.link || row.link === "#")
            return;
          craft.navigation.open(String(row.link));
        }
        onMount(() => {
          craft.navigation.setOptions({ title: "Notifications", largeTitle: true });
          load();
        });
        onDestroy(() => {
          active = false;
        });
        return { FILTERS, NOTIFICATION_FILTERS, active, bearer, craft, cycleFilter, error, filterIndex, filterLabel, groupNotificationsByDay, load, loading, markAllRead, matchesNotificationFilter, notificationRowsFrom, openRow, readToken, rows, sections, signedOut, timeAgo, unread };
      }();
      FILTERS = __stxBundle_c74a7d2096ba["FILTERS"];
      NOTIFICATION_FILTERS = __stxBundle_c74a7d2096ba["NOTIFICATION_FILTERS"];
      active = __stxBundle_c74a7d2096ba["active"];
      bearer = __stxBundle_c74a7d2096ba["bearer"];
      craft = __stxBundle_c74a7d2096ba["craft"];
      cycleFilter = __stxBundle_c74a7d2096ba["cycleFilter"];
      error = __stxBundle_c74a7d2096ba["error"];
      filterIndex = __stxBundle_c74a7d2096ba["filterIndex"];
      filterLabel = __stxBundle_c74a7d2096ba["filterLabel"];
      groupNotificationsByDay = __stxBundle_c74a7d2096ba["groupNotificationsByDay"];
      load = __stxBundle_c74a7d2096ba["load"];
      loading = __stxBundle_c74a7d2096ba["loading"];
      markAllRead = __stxBundle_c74a7d2096ba["markAllRead"];
      matchesNotificationFilter = __stxBundle_c74a7d2096ba["matchesNotificationFilter"];
      notificationRowsFrom = __stxBundle_c74a7d2096ba["notificationRowsFrom"];
      openRow = __stxBundle_c74a7d2096ba["openRow"];
      readToken = __stxBundle_c74a7d2096ba["readToken"];
      rows = __stxBundle_c74a7d2096ba["rows"];
      sections = __stxBundle_c74a7d2096ba["sections"];
      signedOut = __stxBundle_c74a7d2096ba["signedOut"];
      timeAgo = __stxBundle_c74a7d2096ba["timeAgo"];
      unread = __stxBundle_c74a7d2096ba["unread"];
      return { FILTERS, NOTIFICATION_FILTERS, active, bearer, craft, cycleFilter, error, filterIndex, filterLabel, groupNotificationsByDay, load, loading, markAllRead, matchesNotificationFilter, notificationRowsFrom, openRow, readToken, rows, sections, signedOut, timeAgo, unread, __stxBundle_c74a7d2096ba };
    };
    window.__stx_latestSetup = __stx_setup_rxae00qm1c;
    if (window.stx)
      window.stx._latestSetup = __stx_setup_rxae00qm1c;
  } else if (routeName === "leaderboard") {
    let __stx_setup_1ttna6xvbs = function() {
      const { batch, cachedQuery, clearServerData, computed, configureFetch, defineEmits, defineExpose, definePageMeta, defineProps, defineSlots, defineStore, derived, effect, flushKeptState, forgetKeptState, goBack, goForward, inject, invalidateRoute, isDerived, isSignal, keptState, navigate, nextTick, onBeforeMount, onBeforeUnmount, onDestroy, onMount, onMounted, onUnmounted, peek, provide, reactive, ref, refresh, registerStoresClient, setKeptScope, setRouteParams, state, untrack, useAsync, useClickOutside, useColorMode, useCookie, useCounter, useDark, useDebounce, useDebouncedValue, useDocumentVisibility, useEventListener, useFetch, useFocus, useHead, useId, useInterval, useLocalStorage, useMediaQuery, useModel, useMutation, useOptimistic, usePreferredContrast, usePreferredDark, usePreferredLight, usePreferredReducedMotion, useQuery, useReactiveProp, useRef, useRoute, useRouteParam, useRouteParams, useScrollLock, useSearchParams, useSeoMeta, useSessionStorage, useSlots, useStore, useThrottle, useTimeout, useToggle, useWebSocket, watch, watchEffect, watchMultiple, withDefaults } = window.stx;
      var LEADERBOARD_METRICS = undefined;
      var LEADERBOARD_PERIODS = undefined;
      var SCOPES = undefined;
      var active = undefined;
      var avatarInitial = undefined;
      var avatarUrl = undefined;
      var bearer = undefined;
      var craft = undefined;
      var cycleMetric = undefined;
      var cyclePeriod = undefined;
      var cycleScope = undefined;
      var error = undefined;
      var figure = undefined;
      var headline = undefined;
      var initial = undefined;
      var leaderMetricText = undefined;
      var leaderRowsFrom = undefined;
      var leaderSecondaryText = undefined;
      var leaderboardQuery = undefined;
      var load = undefined;
      var loading = undefined;
      var metric = undefined;
      var metricIndex = undefined;
      var metricName = undefined;
      var metricPhrase = undefined;
      var needsSignIn = undefined;
      var openAthlete = undefined;
      var period = undefined;
      var periodIndex = undefined;
      var periodName = undefined;
      var periodPhrase = undefined;
      var photo = undefined;
      var readToken = undefined;
      var rows = undefined;
      var scope = undefined;
      var scopeIndex = undefined;
      var scopeName = undefined;
      var secondary = undefined;
      var __stxBundle_364a981b0f73 = function() {
        var OWN_AVATAR = /^\/api\/avatars\/[1-9]\d{0,9}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;
        function avatarUrl(subject, size = "thumb") {
          const raw = typeof subject === "string" ? subject : subject?.avatar;
          const url = String(raw ?? "").trim();
          if (!url)
            return "";
          if (OWN_AVATAR.test(url))
            return size === "thumb" ? url.replace(/\.jpg$/, "-thumb.jpg") : url;
          return /^(?:https:\/\/|blob:)[^\s"'<>]+$/i.test(url) ? url : "";
        }
        function avatarInitial(name) {
          const text = String(name ?? "").trim();
          if (!text)
            return "·";
          return [...text][0].toUpperCase();
        }
        var LEADERBOARD_PERIODS = ["weekly", "monthly", "alltime"];
        var LEADERBOARD_METRICS = ["distance", "elevation", "activities"];
        function periodPhrase(period) {
          if (period === "monthly")
            return "this month";
          if (period === "alltime")
            return "of all time";
          return "this week";
        }
        function metricPhrase(metric) {
          if (metric === "elevation")
            return "climbed the most";
          if (metric === "activities")
            return "logged the most activities";
          return "covered the most ground";
        }
        function leaderboardQuery(options) {
          const scope = options.scope === "local" && !options.area ? "global" : options.scope;
          const pairs = [
            ["period", options.period],
            ["metric", options.metric],
            ["scope", scope]
          ];
          if (scope === "local" && options.area) {
            pairs.push(["lat", String(Math.round(options.area.lat * 100) / 100)]);
            pairs.push(["lng", String(Math.round(options.area.lng * 100) / 100)]);
          }
          return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
        }
        function leaderRowsFrom(payload) {
          const list = payload?.leaderboard;
          if (!Array.isArray(list))
            return [];
          return list.map((entry, index) => {
            const row = entry;
            const userId = Number(row.userId);
            return {
              rank: Number(row.rank) || index + 1,
              userId: Number.isInteger(userId) && userId > 0 ? userId : null,
              userName: String(row.userName || "Athlete"),
              userAvatar: typeof row.userAvatar === "string" && row.userAvatar ? row.userAvatar : null,
              totalDistance: Number(row.totalDistance) || 0,
              totalElevation: Number(row.totalElevation) || 0,
              trailsCompleted: Number(row.trailsCompleted) || 0
            };
          });
        }
        function leaderMetricText(row, metric) {
          if (!row)
            return "";
          if (metric === "elevation")
            return `${row.totalElevation.toLocaleString()} ft`;
          if (metric === "activities")
            return row.trailsCompleted === 1 ? "1 activity" : `${row.trailsCompleted} activities`;
          return `${row.totalDistance.toFixed(1)} mi`;
        }
        function leaderSecondaryText(row, metric) {
          if (!row)
            return "";
          if (metric === "distance")
            return `${row.totalElevation.toLocaleString()} ft`;
          return `${row.totalDistance.toFixed(1)} mi`;
        }
        var craft = globalThis.craft;
        var SCOPES = ["global", "following"];
        var periodIndex = state(0);
        var metricIndex = state(0);
        var scopeIndex = state(0);
        var rows = state([]);
        var loading = state(true);
        var error = state("");
        var needsSignIn = state(false);
        var bearer = state("");
        var active = true;
        function period() {
          return LEADERBOARD_PERIODS[periodIndex()];
        }
        function metric() {
          return LEADERBOARD_METRICS[metricIndex()];
        }
        function scope() {
          return SCOPES[scopeIndex()];
        }
        function headline() {
          return `Who ${metricPhrase(metric())} ${periodPhrase(period())}.`;
        }
        function periodName() {
          return periodPhrase(period());
        }
        function metricName() {
          return metricPhrase(metric());
        }
        function scopeName() {
          return scope() === "following" ? "People you follow" : "Everyone";
        }
        function figure(row) {
          return leaderMetricText(row, metric());
        }
        function secondary(row) {
          return leaderSecondaryText(row, metric());
        }
        function photo(row) {
          return avatarUrl(row?.userAvatar ?? null);
        }
        function initial(row) {
          return avatarInitial(row?.userName ?? "");
        }
        async function readToken() {
          if (bearer())
            return bearer();
          const value = await craft.secureStorage.get("auth_token");
          const token = typeof value === "string" ? value : "";
          bearer.set(token);
          return token;
        }
        async function load() {
          loading.set(true);
          error.set("");
          needsSignIn.set(false);
          try {
            const headers = { Accept: "application/json" };
            if (scope() === "following") {
              const token = await readToken();
              if (!token) {
                if (active) {
                  needsSignIn.set(true);
                  rows.set([]);
                  loading.set(false);
                }
                return;
              }
              headers.Authorization = `Bearer ${token}`;
            }
            const query = leaderboardQuery({ period: period(), metric: metric(), scope: scope() });
            const response = await fetch(`https://wildloop.org/api/activities/leaderboard?${query}`, { headers });
            const body = await response.json().catch(() => null);
            if (!active)
              return;
            if (!response.ok)
              throw new Error("Could not load the leaderboard");
            rows.set(leaderRowsFrom(body));
          } catch (cause) {
            if (active)
              error.set(cause instanceof Error ? cause.message : "Could not load the leaderboard");
          } finally {
            if (active)
              loading.set(false);
          }
        }
        function cyclePeriod() {
          periodIndex.set((periodIndex() + 1) % LEADERBOARD_PERIODS.length);
          load();
        }
        function cycleMetric() {
          metricIndex.set((metricIndex() + 1) % LEADERBOARD_METRICS.length);
          load();
        }
        function cycleScope() {
          scopeIndex.set((scopeIndex() + 1) % SCOPES.length);
          load();
        }
        function openAthlete(row) {
          if (!row?.userId)
            return;
          craft.navigation.open(`/athlete/${row.userId}`);
        }
        onMount(() => {
          craft.navigation.setOptions({ title: "Leaderboard", largeTitle: true });
          load();
        });
        onDestroy(() => {
          active = false;
        });
        return { LEADERBOARD_METRICS, LEADERBOARD_PERIODS, SCOPES, active, avatarInitial, avatarUrl, bearer, craft, cycleMetric, cyclePeriod, cycleScope, error, figure, headline, initial, leaderMetricText, leaderRowsFrom, leaderSecondaryText, leaderboardQuery, load, loading, metric, metricIndex, metricName, metricPhrase, needsSignIn, openAthlete, period, periodIndex, periodName, periodPhrase, photo, readToken, rows, scope, scopeIndex, scopeName, secondary };
      }();
      LEADERBOARD_METRICS = __stxBundle_364a981b0f73["LEADERBOARD_METRICS"];
      LEADERBOARD_PERIODS = __stxBundle_364a981b0f73["LEADERBOARD_PERIODS"];
      SCOPES = __stxBundle_364a981b0f73["SCOPES"];
      active = __stxBundle_364a981b0f73["active"];
      avatarInitial = __stxBundle_364a981b0f73["avatarInitial"];
      avatarUrl = __stxBundle_364a981b0f73["avatarUrl"];
      bearer = __stxBundle_364a981b0f73["bearer"];
      craft = __stxBundle_364a981b0f73["craft"];
      cycleMetric = __stxBundle_364a981b0f73["cycleMetric"];
      cyclePeriod = __stxBundle_364a981b0f73["cyclePeriod"];
      cycleScope = __stxBundle_364a981b0f73["cycleScope"];
      error = __stxBundle_364a981b0f73["error"];
      figure = __stxBundle_364a981b0f73["figure"];
      headline = __stxBundle_364a981b0f73["headline"];
      initial = __stxBundle_364a981b0f73["initial"];
      leaderMetricText = __stxBundle_364a981b0f73["leaderMetricText"];
      leaderRowsFrom = __stxBundle_364a981b0f73["leaderRowsFrom"];
      leaderSecondaryText = __stxBundle_364a981b0f73["leaderSecondaryText"];
      leaderboardQuery = __stxBundle_364a981b0f73["leaderboardQuery"];
      load = __stxBundle_364a981b0f73["load"];
      loading = __stxBundle_364a981b0f73["loading"];
      metric = __stxBundle_364a981b0f73["metric"];
      metricIndex = __stxBundle_364a981b0f73["metricIndex"];
      metricName = __stxBundle_364a981b0f73["metricName"];
      metricPhrase = __stxBundle_364a981b0f73["metricPhrase"];
      needsSignIn = __stxBundle_364a981b0f73["needsSignIn"];
      openAthlete = __stxBundle_364a981b0f73["openAthlete"];
      period = __stxBundle_364a981b0f73["period"];
      periodIndex = __stxBundle_364a981b0f73["periodIndex"];
      periodName = __stxBundle_364a981b0f73["periodName"];
      periodPhrase = __stxBundle_364a981b0f73["periodPhrase"];
      photo = __stxBundle_364a981b0f73["photo"];
      readToken = __stxBundle_364a981b0f73["readToken"];
      rows = __stxBundle_364a981b0f73["rows"];
      scope = __stxBundle_364a981b0f73["scope"];
      scopeIndex = __stxBundle_364a981b0f73["scopeIndex"];
      scopeName = __stxBundle_364a981b0f73["scopeName"];
      secondary = __stxBundle_364a981b0f73["secondary"];
      return { LEADERBOARD_METRICS, LEADERBOARD_PERIODS, SCOPES, active, avatarInitial, avatarUrl, bearer, craft, cycleMetric, cyclePeriod, cycleScope, error, figure, headline, initial, leaderMetricText, leaderRowsFrom, leaderSecondaryText, leaderboardQuery, load, loading, metric, metricIndex, metricName, metricPhrase, needsSignIn, openAthlete, period, periodIndex, periodName, periodPhrase, photo, readToken, rows, scope, scopeIndex, scopeName, secondary, __stxBundle_364a981b0f73 };
    };
    window.__stx_latestSetup = __stx_setup_1ttna6xvbs;
    if (window.stx)
      window.stx._latestSetup = __stx_setup_1ttna6xvbs;
  } else if (routeName === "zzprobe") {
    let __stx_setup_154s60yhgc = function() {
      const { batch, cachedQuery, clearServerData, computed, configureFetch, defineEmits, defineExpose, definePageMeta, defineProps, defineSlots, defineStore, derived, effect, flushKeptState, forgetKeptState, goBack, goForward, inject, invalidateRoute, isDerived, isSignal, keptState, navigate, nextTick, onBeforeMount, onBeforeUnmount, onDestroy, onMount, onMounted, onUnmounted, peek, provide, reactive, ref, refresh, registerStoresClient, setKeptScope, setRouteParams, state, untrack, useAsync, useClickOutside, useColorMode, useCookie, useCounter, useDark, useDebounce, useDebouncedValue, useDocumentVisibility, useEventListener, useFetch, useFocus, useHead, useId, useInterval, useLocalStorage, useMediaQuery, useModel, useMutation, useOptimistic, usePreferredContrast, usePreferredDark, usePreferredLight, usePreferredReducedMotion, useQuery, useReactiveProp, useRef, useRoute, useRouteParam, useRouteParams, useScrollLock, useSearchParams, useSeoMeta, useSessionStorage, useSlots, useStore, useThrottle, useTimeout, useToggle, useWebSocket, watch, watchEffect, watchMultiple, withDefaults } = window.stx;
      const craft = globalThis.craft;
      const onAtMount = state(true);
      const flipped = state(false);
      const log = state("none");
      function always() {
        log.set("always-ran");
      }
      function mounted() {
        log.set("mounted-ran");
      }
      function later() {
        log.set("later-ran");
      }
      onMount(() => {
        craft.navigation.setOptions({ title: "Probe" });
        flipped.set(true);
      });
      return { craft, onAtMount, flipped, log, always, mounted, later };
    };
    window.__stx_latestSetup = __stx_setup_154s60yhgc;
    if (window.stx)
      window.stx._latestSetup = __stx_setup_154s60yhgc;
  }
  screen.mount(g.stx, g.__stx_latestSetup || null);
})();