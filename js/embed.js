/**
 * embed.js — ThoughtSpot Visual Embed SDK wrapper
 *
 * Exported functions:
 *   initSDK(config)                                — initialises the SDK with AuthType.None
 *   doRender(section, config, callbacks, options)  — creates and renders the embed component
 */

import {
  init,
  AuthType,
  SearchEmbed,
  SearchBarEmbed,
  SpotterEmbed,
  LiveboardEmbed,
  AppEmbed,
  EmbedEvent,
  Page,
  HostEvent,
  Action,
  RuntimeFilterOp,
  CustomActionsPosition,
} from 'https://unpkg.com/@thoughtspot/visual-embed-sdk/dist/tsembed.es.js';

/**
 * Initialise the ThoughtSpot SDK.
 *
 * @param {{ thoughtSpotHost: string, authType: string }} config  TS_CONFIG object
 */
export function initSDK(config) {
  init({
    thoughtSpotHost: config.thoughtSpotHost,
    authType: AuthType[config.authType] ?? AuthType.None,
    ...(config._customStyles && {
      customizations: { style: config._customStyles }
    }),
  });
}

/**
 * Create and render a ThoughtSpot embed component into #ts-embed-container.
 *
 * @param {string} section   One of: 'search' | 'spotter' | 'liveboard' | 'viz' | 'fullapp'
 * @param {object} config    The TS_CONFIG object
 * @param {{
 *   onDone:  () => void,
 *   onError: (msg: string) => void,
 *   onEvent: (type: string, data: any) => void,
 * }} callbacks
 * @param {{
 *   hiddenActions?: string[],
 *   disabledActions?: string[],
 *   customActions?: object[],
 * }} options
 * @returns {object}  The embed instance (so the caller can call .destroy() later)
 */
export function doRender(section, config, callbacks, options = {}) {
  const { onDone, onError, onEvent } = callbacks;
  const { hiddenActions = [], disabledActions = [], customActions = [], runtimeParameters = [], flags = {} } = options;
  const rtParams = runtimeParameters.length ? runtimeParameters : undefined;

  let embed;

  switch (section) {
    case 'search':
      embed = new SearchEmbed('#ts-embed-container', {
        frameParams: {},
        collapseDataSources: true,
        dataSources: [config.worksheetId],
        hiddenActions,
        disabledActions,
        ...(config.searchTokenString && {
          searchOptions: {
            searchTokenString: config.searchTokenString,
            executeSearch: config.executeSearch,
          },
        }),
        ...(rtParams && { runtimeParameters: rtParams }),
        ...flags,
      });
      break;

    case 'nlsearch':
      embed = new SearchBarEmbed('#ts-embed-container', {
        frameParams: {},
        dataSources: [config.worksheetId],
        hiddenActions,
        disabledActions,
        ...flags,
      });
      break;

    case 'spotter':
      embed = new SpotterEmbed('#ts-embed-container', {
        frameParams: {},
        worksheetId: config.worksheetId,
        hiddenActions,
        disabledActions,
        ...flags,
      });
      break;

    case 'liveboard':
    case 'liveboard-custom':
      embed = new LiveboardEmbed('#ts-embed-container', {
        frameParams: {},
        liveboardV2: true,
        liveboardId: config.liveboardId,
        hiddenActions,
        disabledActions,
        customActions,
        ...(rtParams && { runtimeParameters: rtParams }),
        ...flags,
      });
      break;

    case 'viz':
      embed = new LiveboardEmbed('#ts-embed-container', {
        frameParams: {},
        liveboardV2: true,
        liveboardId: config.liveboardId,
        vizId: config.vizId,
        hiddenActions,
        disabledActions,
        customActions,
        ...(rtParams && { runtimeParameters: rtParams }),
        ...flags,
      });
      break;

    case 'fullapp': {
      const appFlags = { ...flags };
      if (appFlags.pageId && typeof appFlags.pageId === 'string') {
        appFlags.pageId = Page[appFlags.pageId] ?? Page.Home;
      }
      embed = new AppEmbed('#ts-embed-container', {
        frameParams: {},
        showPrimaryNavbar: false,
        pageId: Page.Home,
        modularHomeExperience: true,
        hiddenActions,
        disabledActions,
        customActions,
        ...appFlags,
      });
      break;
    }

    default:
      onError(`Unknown section: ${section}`);
      return null;
  }

  embed
    .on(EmbedEvent.AuthInit, () => {
      onEvent('AuthInit', 'Auth initialized');
    })
    .on(EmbedEvent.EmbedListenerReady, () => {
      onDone();
      onEvent('EmbedListenerReady', 'Embed container ready');
    })
    .on(EmbedEvent.Load, () => {
      onDone();
      onEvent('Load', 'Embed loaded successfully');
    })
    .on(EmbedEvent.LiveboardRendered, () => {
      onDone();
      onEvent('LiveboardRendered', 'Liveboard rendered');
    })
    .on(EmbedEvent.NoCookieAccess, () => {
      onDone();
      onError('__NO_COOKIE__');
      onEvent('NoCookieAccess', '⚠ Third-party cookies blocked — enable cookies or use a different auth type');
    })
    .on(EmbedEvent.Error, (e) => {
      let msg = e?.error?.message ?? e?.message ?? JSON.stringify(e);
      // Detect invalid data source GUID — give an actionable hint
      const raw = JSON.stringify(e);
      if (raw.includes('Invalid data source guid') || raw.includes('invalid data source')) {
        const guid = raw.match(/guid[":]+\s*([0-9a-f-]{36})/i)?.[1] ?? '';
        msg = `Invalid data source GUID${guid ? ' (' + guid + ')' : ''}. GUIDs are org-specific — if you switched orgs in ThoughtSpot, open ⚙ Settings and update the Worksheet, Liveboard, and Viz GUIDs for the current org.`;
      }
      onError(msg);
      onEvent('Error', msg);
    })
    .on(EmbedEvent.Data, () => {
      onEvent('Data', 'Data payload received');
    })
    .on(EmbedEvent.CustomAction, (payload) => {
      onEvent('CustomAction', JSON.stringify(payload?.data ?? payload, null, 2));
      // Notify app.js to display in the custom action panel
      if (window.__onCustomAction) window.__onCustomAction(payload);
    });

  embed.render();
  return embed;
}

export { HostEvent, Action, RuntimeFilterOp, CustomActionsPosition };
