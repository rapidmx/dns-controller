///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** The controller may no longer write (the Lease is lost, or it is stopping): whatever pass is under way stops at once. */
export class NotWriterError extends Error {}
