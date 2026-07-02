# useLukkForm

Most of what a Laravel app does is submit a form and show the validation errors it gets back. `useLukkForm` is the client for exactly that: hold the fields, submit them to your API, and bind a Laravel `422` bag onto per-field errors — over [`useLukkFetch`](/use-lukk-fetch), so it is authenticated, SSR-correct, and identical in either [transport mode](/transport-modes). It is modelled closely on Inertia's `useForm`, so it should feel familiar.

## `useLukkForm`

```ts
const form = useLukkForm(initialData, options?)
```

`useLukkForm` returns a single reactive object. The **fields live under `form.data`** (not spread onto the form itself), so a field may safely be named `errors`, `processing`, or `submit`. Every `useLukkForm()` call is an independent form.

```ts
const form = useLukkForm({ email: '', password: '' })

form.data          // { email, password } — the live, editable fields
form.errors        // { email?: string, password?: string } — first message per field
form.processing    // boolean — a submit is in flight
form.hasErrors     // boolean
form.isDirty       // boolean — data differs from the defaults
form.wasSuccessful // boolean — the last submit succeeded
form.recentlySuccessful // boolean — true briefly after success (for a "Saved!" flash)
```

The optional second argument configures the form:

```ts
useLukkForm({ … }, {
  recentlySuccessfulMs: 2000, // how long recentlySuccessful stays true
  rememberKey: 'signup',      // persist form.data across SPA navigation (Nuxt useState)
})
```

With `rememberKey`, a half-filled form survives a route change and back — mount another form with the same key and its `data` is restored. (The reset/`isDirty` baseline isn't remembered; `isDirty` compares the restored data against the original `initial`.) Use it for **plain** drafts: the state is serialized into the SSR payload, so don't remember `File`/`Blob` fields or sensitive values.

The value type flows through, so `form.data.email` is typed, and the returned form is a `LukkForm<T>`.

## Basic Usage

Bind the fields with `v-model="form.data.*"`, submit with a verb, and read `form.errors` in the template:

```vue
<script setup lang="ts">
const form = useLukkForm({ email: '', password: '' })

async function register() {
  try {
    await form.post('/register')     // form.data is sent as the body
    await navigateTo('/dashboard')
  }
  catch {
    // The 422 is already bound to form.errors; other failures rethrow to your handler.
  }
}
</script>

<template>
  <form @submit.prevent="register">
    <input v-model="form.data.email" type="email">
    <small v-if="form.errors.email">{{ form.errors.email }}</small>

    <input v-model="form.data.password" type="password">
    <small v-if="form.errors.password">{{ form.errors.password }}</small>

    <button :disabled="form.processing">Create account</button>
  </form>
</template>
```

That is the whole loop — no manual error plumbing, no `Accept` headers, no bearer handling.

## Validation Errors

When a submit fails with a Laravel `422`, lukk maps the bag onto `form.errors`, keyed by field. Laravel returns an **array** of messages per field; `form.errors` surfaces the **first** one (the same choice Inertia makes):

```jsonc
// Laravel's 422 body
{ "message": "…", "errors": { "email": ["The email has already been taken."] } }
```

```ts
form.errors.email   // "The email has already been taken."
form.hasErrors      // true
```

**Every submit clears the errors first**, then re-populates them only from a `422` — so a stale message never lingers into the next attempt.

> [!NOTE]
> **Nested & array fields.** Laravel flattens the bag into **dot notation** — nested objects as `authorization.role`, array items as `users.0.email`. `form.errors` keys them exactly as returned, so read them with bracket access: `form.errors['authorization.role']`. For a nested `form.data`, use **`form.nestedErrors`** — the same errors expanded into a nested object: bind `form.nestedErrors.authorization?.role`, and array fields nest under their index, `form.nestedErrors.users?.[0]?.email`.

You can also drive errors yourself (e.g. from a client-side check). All of these are **chainable** (they return the form):

```ts
form.setError('email', 'That address looks off.')
form.setError({ email: 'Required.', password: 'Too short.' }) // set several at once

form.clearErrors('email')  // clear one (or several) fields
form.clearErrors()         // clear all
```

## Submitting

There is a method per verb, plus a generic `submit`:

```ts
form.post('/register')
form.put(`/posts/${id}`)
form.patch(`/users/${id}`)
form.delete(`/posts/${id}`)
form.get('/search')                 // sends the fields as the query string
form.submit('post', '/register')    // the generic form
```

For every verb except `get`, `form.data` is sent as the **request body**; `get` sends the (flat) fields as the **query string**.

Each call **returns a promise of the parsed response body**, and **rejects with a typed [`LukkError`](/lukk-core#errors)** (`{ status, message, errors }`) on failure — so you can `await` the result, or `try/catch` and branch on `status`:

```ts
const user = await form.post<User>('/register') // typed via the generic

try {
  await form.put(`/posts/${id}`)
}
catch (e) {
  if ((e as LukkError).status === 403) { /* … */ }
}
```

The last argument accepts per-submit **[`ofetch` options](/use-lukk-fetch)** (headers, `signal`, …) alongside the lifecycle hooks below:

```ts
form.post('/posts', { headers: { 'X-Idempotency-Key': key } })
```

## Lifecycle Hooks

Pass `onSuccess`, `onError`, and `onFinish` in the submit options. They run in addition to the returned promise, and mirror Inertia's callbacks:

```ts
form.post('/posts', {
  onSuccess: (post) => navigateTo(`/posts/${post.id}`),
  onError:   (error) => console.warn(error.message),
  onFinish:  () => { /* runs on success AND failure — like `finally` */ },
})
```

- `onSuccess(result)` — the parsed response body.
- `onError(lukkError)` — the typed error (also rethrown to your `await`/`catch`).
- `onFinish()` — always runs, even if the request fails or `onSuccess` throws.

## Form State

Beyond `processing` and `hasErrors`, the form tracks the outcome of the last submit — handy for buttons and "Saved!" flashes:

```vue
<button :disabled="form.processing">
  {{ form.processing ? 'Saving…' : 'Save' }}
</button>
<span v-if="form.recentlySuccessful">Saved ✓</span>
```

- **`processing`** — a submit is in flight. Reset on every exit path (success or failure).
- **`wasSuccessful`** — the last submit succeeded. Reset at the start of the next submit.
- **`recentlySuccessful`** — flips to `true` on success and back to `false` after `recentlySuccessfulMs` (default 2000).
- **`isDirty`** — whether `form.data` differs from the current defaults (see below).

## Defaults & Resetting

A form remembers its **defaults** — initially the data you passed in. `reset` restores them, and `isDirty` compares against them:

```ts
form.reset()             // restore every field to its default
form.reset('email')      // restore only some fields
form.resetAndClearErrors() // reset AND clear the errors in one call
```

You may re-baseline the defaults with `defaults` — for example after loading an edit form, so `isDirty` starts clean and `reset` returns to the loaded values:

```ts
const form = useLukkForm({ title: '', body: '' })

const post = await $lukk('/posts/1')   // load current values
form.data.title = post.title
form.data.body = post.body
form.defaults()                         // baseline := current data → isDirty is false again

form.defaults('title', 'Untitled')      // re-baseline a single field
form.defaults({ title: '…', body: '…' })// or several
```

**On a successful submit, the defaults are re-baselined to the just-submitted data automatically**, so `isDirty` flips back to `false` after a save. For a *create* form where you want the fields cleared instead, call `reset()` in `onSuccess`:

```ts
form.post('/posts', { onSuccess: () => form.reset() }) // clear the form after creating
```

> [!NOTE]
> `isDirty` is a structural (JSON) comparison of `data` vs. the defaults, so it does not diff `File`/`Blob` fields (both serialize to `{}`) — track those separately if you need to.

## Transforming Data

Register a `transform` to map `form.data` into the payload sent on **every subsequent submit** — without mutating the fields the user sees. A classic use is dropping a confirmation field:

```ts
const form = useLukkForm({ password: '', password_confirmation: '' })

form.transform((data) => ({ password: data.password })) // send only `password`

await form.post('/password') // body is { password: '…' }
```

## File Uploads

Put a `File` or `Blob` anywhere in `form.data` and the submit is **automatically sent as `multipart/form-data`** — nested keys are flattened Laravel-style (`avatar`, `tags[0]`, `meta[views]`), booleans become `'1'`/`'0'`, and `Date`s become ISO strings. The [BFF proxy streams the upload](/transport-modes#bff).

```vue
<script setup lang="ts">
const form = useLukkForm({ title: '', avatar: null as File | null })

function onPick(e: Event) {
  form.data.avatar = (e.target as HTMLInputElement).files?.[0] ?? null
}
</script>

<template>
  <form @submit.prevent="form.post('/avatar')">
    <input v-model="form.data.title">
    <input type="file" @change="onPick">
    <button :disabled="form.processing">Upload</button>
  </form>
</template>
```

Force multipart even without a file with `forceFormData: true`. For a `<input type="file" multiple>`, store a `File[]` (spread the `FileList`: `[...files]`) rather than the raw `FileList`.

> [!NOTE]
> Files must be sent by a **body** verb — a `File` in a `get` query is stringified and lost. `File`/`Blob` fields are passed **by reference** through `reset`/`isDirty`/the success rebase, so large uploads are never byte-copied.

## Cancelling a Submit

`form.cancel()` aborts the most-recent in-flight submit; it then rejects with an `AbortError`:

```ts
const form = useLukkForm({ q: '' })

async function search() {
  form.cancel()                 // drop any previous in-flight search
  try {
    results.value = await form.get('/search')
  }
  catch (e) {
    if ((e as Error).name !== 'AbortError') throw e
  }
}
```

If you pass your own `signal` in the submit options, that wins and `cancel()` is a no-op for that submit.

## Notes & Caveats

- **Transport-agnostic.** `useLukkForm` works identically in **BFF** and **direct** mode, and in an `useAsyncData`/SSR context, because it submits through [`useLukkFetch`](/use-lukk-fetch) — which forwards the session on SSR and injects the bearer as the mode requires.
- **Field values must be plain.** Use strings, numbers, booleans, arrays, plain objects, `Date`, `File`/`Blob`. Don't pass functions, class instances, or reactive proxies as fields — `reset`/`isDirty` clone and compare them structurally.
- **`get` flattens only top-level fields** into the query string. Nested objects don't round-trip as query parameters.
- **Chaining.** `setError`, `clearErrors`, `reset`, `resetAndClearErrors`, `defaults`, and `transform` all return the form, so they compose: `form.reset().clearErrors()`.

> [!NOTE]
> A custom `/register` (or bespoke login) route lives on the Laravel side. To hand back a lukk session after your own registration flow, issue tokens with [`startSession()`](/authentication#starting-sessions-manually); to accept a different credential field or add checks at login, use [custom login logic](/customization#custom-login-logic).

Next: **[Using lukk-core](/lukk-core)**.
