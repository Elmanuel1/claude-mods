import type { ClientModule } from 'claude-code'

import type { RulesView } from '../types'
import { rulesView } from './rules-view'

// A Button the hooks module draws is pressed through a handle that every redraw replaces, so a click that
// races a redraw (the pane taking focus, a rescan) is dropped. This module's buttons live on the surface
// and survive redraws; a press posts the action and the hooks module looks the rule up when it arrives.
const RulesClient: ClientModule<RulesView> = (view, surface) =>
  rulesView(surface.elements, view, (action, key) => surface.post({ action, key }))

export default RulesClient
