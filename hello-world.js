calculate = () => {
    let a = document.getElementById("a").value;
    let b = document.getElementById("b").value;
    let op = document.getElementById("operation").value

    let result = 0

    if (a == "") {
        document.getElementById("a").value = 0
    }

    if (b == "") {
        document.getElementById("b").value = 0
    }

    aValue = parseFloat(a)
    bValue = parseFloat(b)

    switch (op) {
        case "+":
            result = aValue + bValue
            break
        case "-":
            result = aValue - bValue
            break
        case "*":
            result = aValue * bValue
            break  
        case "/":
            if (bValue == 0) {
                result = "Error: division by zero"
            }
            else {
                result = aValue / bValue
            }
            break  
        case "^":
            if (a < 0 && !Number.isInteger(bValue)) {
                result = '\u2209\u211D'
            } else {
                result = Math.pow(aValue, bValue)
            }
            break
        
        case "":
            result = "Operator error"
            break
        default:
            result = "Error"         
    }



    document.getElementById("output").value = result




    //return event.charCode >= 48 && event.charCode <= 57 || event.charCode === 46 || event.charCode === 45
}


check = (value, id) => {
    let elementId = ''
    if (id == 1) {
        elementId = 'a'
    }
    else if (id == 2) {

        elementId = 'b'
    }
    for (var i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) < 45 || value.charCodeAt(i) > 57 || (value.charAt(i) == '-' && i != 0) || value.split('.').length > 2) {
            document.getElementById(elementId).value = value.substring(0, value.length-1) //document.getElementById('a').value.replace(document.getElementById('a').value.charAt(i), '')
            break    
        }
        // if (value.charAt(i) == '-' && i != 0) {
        //     document.getElementById('a').value = value.substring(0, value.length-1)
        //     break
        // }
        
      }
}
