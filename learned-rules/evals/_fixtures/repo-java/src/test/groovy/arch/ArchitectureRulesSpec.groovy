package arch

import com.tngtech.archunit.core.importer.ClassFileImporter
import com.tngtech.archunit.lang.ArchRule
import com.tngtech.archunit.library.freeze.FreezingArchRule
import spock.lang.Specification

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes

// The CLAUDE.md structure rules over every module's classes. Violations that existed when a rule was added are
// recorded in src/test/resources/archunit_store; a new one fails.
class ArchitectureRulesSpec extends Specification {

    def "#rule.description"() {
        when:
        FreezingArchRule.freeze(rule).check(new ClassFileImporter().importPackages('com.acme'))

        then:
        noExceptionThrown()

        where:
        rule << RULES
    }

    static final List<ArchRule> RULES = [
            classes().that().areAssignableTo(Throwable).should().resideInAPackage('com.acme.models.exception..')
                    .as('Rule 3: exceptions live in com.acme.models.exception'),
    ]
}
