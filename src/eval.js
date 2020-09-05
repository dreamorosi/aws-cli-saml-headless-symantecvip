module.exports = {
    func1: () => document.querySelector('#saml_form input[name="SAMLResponse"]').value,
    func2: ```() => {
        let accountsNodes = document.querySelectorAll('.saml-account:not([id])')
        let accounts = {}
        accountsNodes.forEach((el) => {
            let accountLabel = el.querySelector('.saml-account-name').textContent
            let accountId = accountLabel.match(/\d{12}/)
            let rolesContainerNode = el.querySelectorAll('.saml-account[id] .saml-role')
            let roles = []
            rolesContainerNode.forEach(el => {
                let roleLabel = el.querySelector('label')
                roles.push({
                    name: roleLabel.textContent,
                    arn: roleLabel.getAttribute('for')
                })
            })
            accounts[accountId] = roles
        })
        return accounts
    }```
};