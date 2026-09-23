// Package fixture is a negative fixture: it vets and builds but has no tests,
// so ship/assets/ci-go.yml must fail it.
package fixture

// Add returns a + b.
func Add(a, b int) int {
	return a + b
}
