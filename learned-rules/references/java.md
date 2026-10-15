# Java: writing and ratcheting a check

This page is a worked example: a multi-module Gradle and Spring Boot repo that turned its written coding rules
(a `CLAUDE.md`) into checks. Each check fails a build only on violations added after the check was, and each failure
message names the written rule it enforces, so a reader can find the reason.

Pick the tool by what the rule is about:

| The rule is about | Tool | Where it lives |
|---|---|---|
| Class structure: layers, dependencies, naming, annotations, signatures, packages | ArchUnit | one test class over every module's compiled classes |
| Code inside a method: a call, a literal, a statement form | PMD XPath rule | the project's PMD ruleset XML |
| Types or data flow PMD cannot express | Error Prone custom `BugChecker` | a checker module on the compiler's annotation processor path |
| File length | a Gradle task | a baseline file of line counts |
| Test coverage | JaCoCo verification | per-module floors |
| Formatting and unused imports on changed files | Spotless with `ratchetFrom` | the Gradle build |

## ArchUnit: one test over every module

A single test (a JUnit or Spock class in the module that assembles the application) imports the production classes of
every module and checks the rule list against them. The Gradle `test` task passes the class directories in a system
property, so the test sees every module without a dependency on each one:

```groovy
def architectureModules = rootProject.subprojects.findAll { new File(it.projectDir, 'src/main/java').exists() }
def classDirs = architectureModules.collect { new File(it.projectDir, 'build/classes/java/main') }
test {
    dependsOn architectureModules.collect { "${it.path}:classes" }
    inputs.files(classDirs).withPropertyName('architectureClasses')
    systemProperty 'architecture.classDirs', classDirs.join(File.pathSeparator)
    // -PfreezeArchRules records today's violations as the accepted baseline.
    if (providers.gradleProperty('freezeArchRules').isPresent()) {
        systemProperty 'archunit.freeze.store.default.allowStoreCreation', 'true'
        systemProperty 'archunit.freeze.refreeze', 'true'
    }
}
```

Each rule is frozen, so the violations that existed when it was added sit in `archunit_store` and only new ones fail.
`archunit.properties` keeps `freeze.store.default.allowStoreCreation=false`, so a rule nobody froze cannot pass by
writing its own store in CI. Generated code (OpenAPI, jOOQ, MapStruct implementations) is filtered out before the check.

```groovy
static final List<ArchRule> RULES = [
    noClasses().that(CONTROLLER).or(EVENT_CONSUMER)
            .should().dependOnClassesThat(REPOSITORY)
            .as('Rule 22: controllers and event listeners do not depend on repositories'),
    classes().that().areAssignableTo(Throwable).should().resideInAPackage('..models.exception..')
            .as('Rule 8: exceptions live in the models exception package'),
]

def "#rule.description"() {
    when:
    FreezingArchRule.freeze(rule).check(production)
    then:
    noExceptionThrown()
    where:
    rule << RULES
}
```

Shared predicates (`CONTROLLER`, `REPOSITORY`, "takes a `DSLContext`") live in one class next to the test, so two rules
never define "repository" differently. A Groovy or Spock rule about tests is an ArchUnit rule over the test classes,
since both compile to bytecode.

## PMD: XPath rules with a per-file ratchet

Rules about code inside a method are XPath rules in one ruleset. The `message` starts with the written rule's number:

```xml
<rule name="NowWithoutUtc" language="java" class="net.sourceforge.pmd.lang.rule.xpath.XPathRule"
      message="Rule 18: take the time as OffsetDateTime.now(ZoneOffset.UTC)">
    <properties>
        <property name="xpath">
            <value><![CDATA[
//MethodCall[pmd-java:matchesSig('java.time.OffsetDateTime#now(_*)')]
    [not(ArgumentList/*[@Name = 'UTC'])]
]]></value>
        </property>
    </properties>
</rule>
```

PMD runs with `ignoreFailures = true`; a `pmdRatchet` task reads every module's XML report and compares the count of
each rule in each file with a baseline file (`rule<TAB>path<TAB>count`):

- more violations of a rule in a file than the baseline allows fails;
- fewer also fails, until the baseline is lowered, so a fixed violation cannot come back;
- a file PMD could not analyse fails, since `ignoreFailures` would otherwise hide it;
- `-PupdatePmdBaseline` records today's counts.

Counts, not line numbers, so editing an old file does not trip it. Generated sources are excluded by the module's build
directory, not by any `/build/` in the path.

## Choosing between them

- The rule is visible in a class's dependencies, annotations, names or method signatures: ArchUnit.
- The rule is visible in one expression or statement: PMD XPath. Test the XPath on the rule's BAD and GOOD examples
  with PMD's designer or a small fixture file before adding it.
- The rule needs to know a type PMD cannot resolve, or follow a value between statements: Error Prone.
- A rule both tools could check goes in ArchUnit, which reads compiled classes and so cannot be fooled by formatting.
