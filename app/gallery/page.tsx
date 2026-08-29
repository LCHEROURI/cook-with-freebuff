'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function GalleryPage() {
  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground sm:px-10">
      <div className="mx-auto max-w-5xl space-y-8">
        <header className="space-y-2">
          <Badge variant="outline">Warm Kitchen · shadcn/ui</Badge>
          <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">Component gallery</h1>
          <p className="max-w-2xl text-muted-foreground">
            A visual reference for the shared primitives and semantic tokens. Use your system light/dark preference to inspect both themes.
          </p>
        </header>

        <section aria-labelledby="buttons-heading" className="space-y-4">
          <h2 id="buttons-heading" className="text-xl font-semibold">Buttons</h2>
          <div className="flex flex-wrap gap-3">
            <Button>Start cooking</Button>
            <Button variant="secondary">Save recipe</Button>
            <Button variant="outline">View ingredients</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="destructive">Delete recipe</Button>
            <Button variant="link">Open kitchen</Button>
          </div>
        </section>

        <section aria-labelledby="badges-heading" className="space-y-4">
          <h2 id="badges-heading" className="text-xl font-semibold">Badges</h2>
          <div className="flex flex-wrap gap-3">
            <Badge>Ready</Badge>
            <Badge variant="secondary">Prep · 15 min</Badge>
            <Badge variant="outline">Vegetarian</Badge>
            <Badge className="border-transparent bg-accent text-accent-foreground">Cooking</Badge>
            <Badge className="border-transparent bg-destructive text-destructive-foreground">Needs attention</Badge>
          </div>
        </section>

        <Card>
          <CardHeader>
            <CardTitle>Build your next meal</CardTitle>
            <CardDescription>Inputs, labels, buttons, and cards share the same Warm-Kitchen token layer.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ingredient-input">Ingredients</Label>
              <Input id="ingredient-input" placeholder="chicken, rice, onion" />
              <p className="text-sm text-muted-foreground">Try focus, placeholder, and disabled states.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="notes-input">Notes</Label>
              <Input id="notes-input" placeholder="No peanuts, serves 4" disabled />
              <p className="text-sm text-muted-foreground">Muted text remains readable in both themes.</p>
            </div>
          </CardContent>
          <CardFooter className="justify-end gap-3">
            <Button variant="outline">Preview</Button>
            <Button>Continue</Button>
          </CardFooter>
        </Card>

        <div className="grid gap-6 md:grid-cols-3">
          {[
            ['Sky blue', 'bg-primary', 'text-primary-foreground'],
            ['Warm orange', 'bg-accent', 'text-accent-foreground'],
            ['Mauve herb', 'bg-secondary', 'text-secondary-foreground'],
          ].map(([title, background, foreground]) => (
            <Card key={title}>
              <CardContent className="space-y-4 pt-6">
                <div className={`h-20 rounded-md ${background}`}>
                  <span className={`flex h-full items-center justify-center text-sm font-semibold ${foreground}`}>{title}</span>
                </div>
                <p className="text-sm text-muted-foreground">Surface, border, focus, and text tokens are inherited from the existing brand palette.</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </main>
  );
}
