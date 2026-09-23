// Package fixture is the smallest Go package that ship/assets/ci-go.yml must pass on.
package fixture

// Add returns a + b.
func Add(a, b int) int {
	return a + b
}
